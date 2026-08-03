import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Http } from '../lib/http.ts';
import { fetchCollectors } from './collectors.ts';

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
