import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Http } from '../lib/http.ts';
import { discover } from './discover.ts';

function stub(payload: unknown) {
  const bodies: unknown[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as unknown as typeof fetch;
  return { http: new Http({ fetchImpl: impl, minDelayMs: 0 }), bodies };
}

const result = {
  item_id: 2309993853,
  item_type: 'a',
  title: 'Rush',
  item_url: 'https://rebel-base-ngt.bandcamp.com/album/-?from=discover_page',
  band_name: 'ngt.',
  band_location: 'Japan',
};

test('тег и слайс уходят в тело запроса', async () => {
  const { http, bodies } = stub({ results: [result] });
  await discover(http, { tag: 'crust', slice: 'new', size: 40 });
  assert.deepEqual(bodies[0], {
    category_id: 0,
    tag_norm_names: ['crust'],
    geoname_id: 0,
    slice: 'new',
    time_facet_id: null,
    size: 40,
    cursor: '*',
    include_result_types: ['a'],
  });
});

test('служебный from=discover_page отрезается от ссылки', async () => {
  const { http } = stub({ results: [result] });
  const [first] = await discover(http, { tag: 'crust', slice: 'new' });
  assert.equal(first?.url, 'https://rebel-base-ngt.bandcamp.com/album/-');
});

test('пустой ответ отдаёт пустой список, а не падение', async () => {
  const { http } = stub({ results: [] });
  assert.deepEqual(await discover(http, { tag: 'crust', slice: 'new' }), []);
});

test('ответ с ошибкой отдаёт пустой список', async () => {
  const { http } = stub({ error: true, error_message: 'bad function' });
  assert.deepEqual(await discover(http, { tag: 'crust', slice: 'new' }), []);
});
