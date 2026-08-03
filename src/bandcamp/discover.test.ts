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

const result = {
  item_id: 2309993853,
  item_type: 'a',
  title: 'Rush',
  item_url: 'https://rebel-base-ngt.bandcamp.com/album/-?from=discover_page',
  band_name: 'ngt.',
  band_location: 'Japan',
};

test('тег и слайс уходят в тело запроса', async () => {
  const { http, bodies } = stub({ results: [result], result_count: 1 });
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

test('человекочитаемый тег с пробелами уходит в API как дефисный слаг', async () => {
  // Живой прогон 2026-08 показал: tag_norm_names с буквальным пробелом
  // ('black metal', 'old school death metal', 'raw black metal') отдаёт
  // result_count: 0, а дефисный слаг того же тега — рабочий непустой хаб.
  // Значит нормализовать нужно до отправки, а не полагаться на вызывающих.
  const { http, bodies } = stub({ results: [result], result_count: 1 });
  await discover(http, { tag: 'old school death metal', slice: 'top' });
  assert.deepEqual((bodies[0] as { tag_norm_names: string[] }).tag_norm_names, ['old-school-death-metal']);
});

test('регистр и лишние пробелы по краям тоже нормализуются', async () => {
  const { http, bodies } = stub({ results: [result], result_count: 1 });
  await discover(http, { tag: '  Black  Metal  ', slice: 'top' });
  assert.deepEqual((bodies[0] as { tag_norm_names: string[] }).tag_norm_names, ['black-metal']);
});

test('уже дефисный тег уходит без изменений', async () => {
  const { http, bodies } = stub({ results: [result], result_count: 1 });
  await discover(http, { tag: 'd-beat', slice: 'top' });
  assert.deepEqual((bodies[0] as { tag_norm_names: string[] }).tag_norm_names, ['d-beat']);
});

test('служебный from=discover_page отрезается от ссылки', async () => {
  const { http } = stub({ results: [result], result_count: 1 });
  const [first] = await discover(http, { tag: 'crust', slice: 'new' });
  assert.equal(first?.url, 'https://rebel-base-ngt.bandcamp.com/album/-');
});

test('пустой ответ отдаёт пустой список, а не падение', async () => {
  const { http } = stub({ results: [], result_count: 0 });
  assert.deepEqual(await discover(http, { tag: 'crust', slice: 'new' }), []);
});

test('генуинно пустой хаб не пишет в лог', async () => {
  const { http } = stub({ results: [], result_count: 0 });
  const { result: items, calls: warnCalls } = await withCapturedConsole('warn', () =>
    discover(http, { tag: 'crust', slice: 'new' }),
  );
  const { calls: errorCalls } = await withCapturedConsole('error', () =>
    discover(http, { tag: 'crust', slice: 'new' }),
  );
  assert.deepEqual(items, []);
  assert.equal(warnCalls.length, 0);
  assert.equal(errorCalls.length, 0);
});

test('ответ с ошибкой отдаёт пустой список и пишет её в лог', async () => {
  const { http } = stub({ error: true, error_message: 'bad function' });
  const { result: items, calls } = await withCapturedConsole('error', () =>
    discover(http, { tag: 'crust', slice: 'new' }),
  );
  assert.deepEqual(items, []);
  assert.equal(calls.length, 1);
  const message = String(calls[0]?.[0]);
  assert.match(message, /crust/);
  assert.match(message, /new/);
  assert.match(message, /bad function/);
});

test('усечённая выборка пишет предупреждение с тегом, слайсом и числами', async () => {
  const { http } = stub({ results: [result], result_count: 5 });
  const { result: items, calls } = await withCapturedConsole('warn', () =>
    discover(http, { tag: 'crust', slice: 'new', size: 1 }),
  );
  assert.equal(items.length, 1);
  assert.equal(calls.length, 1);
  const message = String(calls[0]?.[0]);
  assert.match(message, /crust/);
  assert.match(message, /new/);
  assert.match(message, /1/);
  assert.match(message, /5/);
});
