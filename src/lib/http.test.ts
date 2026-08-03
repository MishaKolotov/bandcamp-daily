import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Http } from './http.ts';

function fakeFetch(pages: Record<string, string>) {
  const calls: string[] = [];
  const impl = async (url: string | URL | Request, init?: RequestInit) => {
    const key = String(url);
    calls.push(key);
    const body = pages[key];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(body, { status: 200 });
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

test('getText возвращает тело страницы', async () => {
  const { impl } = fakeFetch({ 'https://x.test/a': 'hello' });
  const http = new Http({ fetchImpl: impl, minDelayMs: 0 });
  assert.equal(await http.getText('https://x.test/a'), 'hello');
});

test('кэш на диске избавляет от повторного запроса', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bc-http-'));
  const { impl, calls } = fakeFetch({ 'https://x.test/a': 'hello' });
  const http = new Http({ fetchImpl: impl, minDelayMs: 0, cacheDir: dir });
  await http.getText('https://x.test/a', { cache: true });
  const http2 = new Http({ fetchImpl: impl, minDelayMs: 0, cacheDir: dir });
  assert.equal(await http2.getText('https://x.test/a', { cache: true }), 'hello');
  assert.equal(calls.length, 1);
  await rm(dir, { recursive: true, force: true });
});

test('между запросами выдерживается пауза', async () => {
  const { impl } = fakeFetch({ 'https://x.test/a': '1', 'https://x.test/b': '2' });
  const slept: number[] = [];
  const http = new Http({
    fetchImpl: impl,
    minDelayMs: 500,
    sleep: async (ms) => { slept.push(ms); },
    now: (() => { let t = 0; return () => (t += 10); })(),
  });
  await http.getText('https://x.test/a');
  await http.getText('https://x.test/b');
  // now() тикает по +10 на каждый вызов; между первым и вторым запросом прошло 10мс,
  // при minDelayMs=500 пауза должна быть ровно 500-10=490.
  assert.deepEqual(slept, [490]);
});

test('404 приводит к ошибке с URL в тексте', async () => {
  const { impl } = fakeFetch({});
  const http = new Http({ fetchImpl: impl, minDelayMs: 0, retries: 0 });
  await assert.rejects(() => http.getText('https://x.test/missing'), /missing/);
});

test('postJson отдаёт разобранный JSON', async () => {
  const impl = (async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch;
  const http = new Http({ fetchImpl: impl, minDelayMs: 0 });
  assert.deepEqual(await http.postJson('https://x.test/api', { a: 1 }), { ok: true });
});

test('временный сбой (500) с последующим успехом — возвращает тело, ровно 2 запроса', async () => {
  const calls: string[] = [];
  let attempt = 0;
  const impl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    attempt += 1;
    if (attempt === 1) return new Response('server error', { status: 500 });
    return new Response('recovered', { status: 200 });
  }) as unknown as typeof fetch;
  const http = new Http({ fetchImpl: impl, minDelayMs: 0, retries: 2 });
  assert.equal(await http.getText('https://x.test/flaky'), 'recovered');
  assert.equal(calls.length, 2);
});

test('исчерпание ретраев на постоянном 500 — отклоняется, ровно retries+1 запросов', async () => {
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response('server error', { status: 500 });
  }) as unknown as typeof fetch;
  const http = new Http({ fetchImpl: impl, minDelayMs: 0, retries: 1 });
  await assert.rejects(() => http.getText('https://x.test/down'));
  assert.equal(calls.length, 2);
});

test('404 не тратит ретраи — ровно 1 запрос при retries: 2', async () => {
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  const http = new Http({ fetchImpl: impl, minDelayMs: 0, retries: 2 });
  await assert.rejects(() => http.getText('https://x.test/gone'));
  assert.equal(calls.length, 1);
});

test('запросы идут строго по одному, даже если не ждать первый', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const impl = (async (url: string | URL | Request) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    const key = String(url);
    if (key === 'https://x.test/api') return new Response('{"ok":true}', { status: 200 });
    return new Response(`body:${key}`, { status: 200 });
  }) as unknown as typeof fetch;
  const http = new Http({ fetchImpl: impl, minDelayMs: 0 });

  const p1 = http.getText('https://x.test/a');
  const p2 = http.postJson('https://x.test/api', { a: 1 });
  const p3 = http.getText('https://x.test/b');
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

  assert.equal(r1, 'body:https://x.test/a');
  assert.deepEqual(r2, { ok: true });
  assert.equal(r3, 'body:https://x.test/b');
  assert.equal(maxInFlight, 1);
});

test('запросы уходят с нашим User-Agent', async () => {
  let capturedHeaders: HeadersInit | undefined;
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    capturedHeaders = init?.headers;
    return new Response('hello', { status: 200 });
  }) as unknown as typeof fetch;
  const http = new Http({ fetchImpl: impl, minDelayMs: 0 });
  await http.getText('https://x.test/a');
  const headers = capturedHeaders as Record<string, string>;
  assert.match(headers['User-Agent'] ?? '', /^bandcamp-daily\/1\.0/);
});
