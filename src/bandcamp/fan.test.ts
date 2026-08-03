import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Http } from '../lib/http.ts';
import { fetchFanItems, fetchFollowedBands, MAX_PAGES } from './fan.ts';

function apiStub(responses: unknown[]) {
  const bodies: unknown[] = [];
  let index = 0;
  const impl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const payload = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as unknown as typeof fetch;
  return { http: new Http({ fetchImpl: impl, minDelayMs: 0 }), bodies };
}

/** Каждый вызов отдаёт новую страницу с новым токеном и more_available: true —
 * сама по себе никогда не останавливается. Нужна, чтобы проверить лимит страниц. */
function infiniteApiStub() {
  const bodies: unknown[] = [];
  let n = 0;
  const impl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    n += 1;
    return new Response(JSON.stringify({ items: [item(n)], more_available: true }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  return { http: new Http({ fetchImpl: impl, minDelayMs: 0 }), bodies };
}

async function withCapturedWarnings<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; calls: unknown[][] }> {
  const original = console.warn;
  const calls: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    calls.push(args);
  };
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    console.warn = original;
  }
}

// `token` — курсор следующей страницы. См. комментарий у nextToken() в fan.ts:
// это поле каждого ЭЛЕМЕНТА, а не `last_token` в теле ответа — на живом Bandcamp
// `last_token` в теле ответа отставал именно на collection_items.
const item = (id: number) => ({
  item_id: id,
  band_id: 100 + id,
  item_title: `Album ${id}`,
  band_name: `Band ${id}`,
  item_url: `https://label${id}.bandcamp.com/album/a${id}`,
  url_hints: { subdomain: `label${id}` },
  also_collected_count: id,
  added: '31 Jul 2026 21:52:06 GMT',
  token: `TOK-${id}`,
});

test('коллекция собирается со всех страниц', async () => {
  const { http, bodies } = apiStub([
    { items: [item(1), item(2)], more_available: true },
    { items: [item(3)], more_available: false },
  ]);
  const items = await fetchFanItems(http, 7566215, 'collection');
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((i) => i.itemId), [1, 2, 3]);
  assert.equal((bodies[0] as { older_than_token: string }).older_than_token, '9999999999::a::');
  assert.equal((bodies[1] as { older_than_token: string }).older_than_token, 'TOK-2');
});

test('поля раскладываются в доменную структуру', async () => {
  const { http } = apiStub([{ items: [item(7)], more_available: false }]);
  const [first] = await fetchFanItems(http, 7566215, 'collection');
  assert.deepEqual(first, {
    itemId: 7,
    bandId: 107,
    title: 'Album 7',
    artist: 'Band 7',
    url: 'https://label7.bandcamp.com/album/a7',
    subdomain: 'label7',
    alsoCollected: 7,
    addedAt: '2026-07-31',
    source: 'collection',
  });
});

test('вишлист ходит в свой эндпоинт и помечается источником', async () => {
  const urls: string[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ items: [item(1)], more_available: false }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  const http = new Http({ fetchImpl: impl, minDelayMs: 0 });
  const [first] = await fetchFanItems(http, 1, 'wishlist');
  assert.match(urls[0] ?? '', /wishlist_items$/);
  assert.equal(first?.source, 'wishlist');
});

test('подписки читаются из ключа followeers', async () => {
  const { http } = apiStub([
    {
      followeers: [
        {
          band_id: 3398914009,
          name: 'Anesthetic',
          location: 'Omaha, Nebraska',
          url_hints: { subdomain: 'anesthetic402' },
          token: 'TOK-band',
        },
      ],
      more_available: false,
    },
  ]);
  assert.deepEqual(await fetchFollowedBands(http, 1), [
    {
      bandId: 3398914009,
      name: 'Anesthetic',
      subdomain: 'anesthetic402',
      location: 'Omaha, Nebraska',
    },
  ]);
});

test('бесконечная пагинация обрывается лимитом страниц по умолчанию', async () => {
  const { http, bodies } = infiniteApiStub();
  const items = await fetchFanItems(http, 1, 'collection');
  assert.equal(bodies.length, MAX_PAGES);
  assert.equal(items.length, MAX_PAGES);
});

test('усечение лимитом страниц печатает предупреждение с fan id, эндпоинтом и лимитом', async () => {
  const { http } = infiniteApiStub();
  const { calls } = await withCapturedWarnings(() =>
    fetchFanItems(http, 4242, 'collection', { maxPages: 3 }),
  );
  assert.equal(calls.length, 1);
  const message = String(calls[0]?.[0]);
  assert.match(message, /4242/);
  assert.match(message, /collection_items/);
  assert.match(message, /3/);
});

test('кастомный лимит страниц уважается', async () => {
  const { http, bodies } = infiniteApiStub();
  const items = await fetchFanItems(http, 1, 'collection', { maxPages: 5 });
  assert.equal(bodies.length, 5);
  assert.equal(items.length, 5);
});

test('естественный конец пагинации (more_available: false) не печатает предупреждение', async () => {
  const { http } = apiStub([{ items: [item(1)], more_available: false }]);
  const { calls } = await withCapturedWarnings(() => fetchFanItems(http, 1, 'collection'));
  assert.deepEqual(calls, []);
});

test('неразбираемая дата добавления печатает предупреждение и откатывается к 1970-01-01', async () => {
  const { http } = apiStub([{ items: [{ ...item(1), added: 'не дата' }], more_available: false }]);
  const { result, calls } = await withCapturedWarnings(() => fetchFanItems(http, 1, 'collection'));
  assert.equal(result[0]?.addedAt, '1970-01-01');
  assert.equal(calls.length, 1);
  assert.match(String(calls[0]?.[0]), /не дата/);
});

test('отсутствующая дата добавления откатывается к 1970-01-01 молча', async () => {
  const { added: _added, ...withoutAdded } = item(1);
  const { http } = apiStub([{ items: [withoutAdded], more_available: false }]);
  const { result, calls } = await withCapturedWarnings(() => fetchFanItems(http, 1, 'collection'));
  assert.equal(result[0]?.addedAt, '1970-01-01');
  assert.deepEqual(calls, []);
});

test('сетевая ошибка Http не проглатывается — всплывает наверх', async () => {
  const impl = (async () => {
    throw new Error('сеть недоступна');
  }) as unknown as typeof fetch;
  const http = new Http({ fetchImpl: impl, minDelayMs: 0 });
  await assert.rejects(() => fetchFanItems(http, 1, 'collection'), /сеть недоступна/);
});
