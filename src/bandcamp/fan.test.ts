import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Http } from '../lib/http.ts';
import { fetchFanItems, fetchFollowedBands } from './fan.ts';

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

// `token` — курсор следующей страницы. См. комментарий у nextToken() в fan.ts:
// это поле каждого ЭЛЕМЕНТА, а не `last_token` в теле ответа — на живом Bandcamp
// `last_token` оказался снимком состояния всей коллекции, а не курсором.
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
    return new Response(
      JSON.stringify({ items: [item(1)], more_available: false }),
      { status: 200 },
    );
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

test('бесконечная пагинация обрывается лимитом страниц', async () => {
  const { http, bodies } = apiStub([{ items: [item(1)], more_available: true }]);
  const items = await fetchFanItems(http, 1, 'collection');
  assert.ok(bodies.length <= 60, `страниц запрошено ${bodies.length}`);
  assert.ok(items.length > 0);
});
