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
  assert.ok(slept.some((ms) => ms > 0), `ожидалась пауза, получено ${JSON.stringify(slept)}`);
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
