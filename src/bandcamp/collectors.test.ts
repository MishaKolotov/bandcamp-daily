import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Http } from '../lib/http.ts';
import { fetchCollectors } from './collectors.ts';

async function withCapturedConsole<T>(
  method: 'warn' | 'error',
  fn: () => Promise<T>,
): Promise<{ result: T; calls: unknown[][] }> {
  const original = console[method];
  const calls: unknown[][] = [];
  console[method] = (...args: unknown[]) => {
    calls.push(args);
  };
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    console[method] = original;
  }
}

test('возвращает fan_id купивших релиз', async () => {
  const impl = (async () =>
    new Response(
      JSON.stringify({
        results: [
          { fan_id: 7566215, username: 'gigamike666' },
          { fan_id: 42, username: 'someone' },
        ],
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  const http = new Http({ fetchImpl: impl, minDelayMs: 0 });
  assert.deepEqual(await fetchCollectors(http, 2720727045), [7566215, 42]);
});

test('ошибка сети даёт пустой список, а не исключение', async () => {
  const impl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
  const http = new Http({ fetchImpl: impl, minDelayMs: 0, retries: 0 });
  assert.deepEqual(await fetchCollectors(http, 1), []);
});

test('200 с телом, которое не является JSON, даёт пустой список и пишет ошибку в лог', async () => {
  const impl = (async () =>
    new Response('<html>not json</html>', { status: 200 })) as unknown as typeof fetch;
  const http = new Http({ fetchImpl: impl, minDelayMs: 0, retries: 0 });
  const { result, calls } = await withCapturedConsole('error', () => fetchCollectors(http, 1));
  assert.deepEqual(result, []);
  assert.equal(calls.length, 1);
  assert.match(String(calls[0]?.[0]), /1/);
});
