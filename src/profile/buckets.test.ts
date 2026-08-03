import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUCKETS, bucketsOf } from './buckets.ts';

test('описаны ровно три бакета с каналами', () => {
  assert.deepEqual(
    BUCKETS.map((b) => b.id),
    ['crust', 'death-metal', 'hardcore-punk'],
  );
  for (const bucket of BUCKETS) {
    assert.ok(bucket.channelEnv.endsWith('_CHANNEL_ID'), bucket.channelEnv);
    assert.ok(bucket.seedTags.length >= 3, `${bucket.id}: мало seed-тегов`);
  }
});

test('seed-теги уже в нижнем регистре', () => {
  for (const bucket of BUCKETS) {
    for (const tag of bucket.seedTags) {
      assert.equal(tag, tag.toLowerCase(), `${bucket.id}: тег "${tag}" не в нижнем регистре`);
    }
  }
});

test('релиз одного жанра попадает ровно в свой бакет', () => {
  assert.deepEqual(bucketsOf(['d-beat', 'crust punk']), ['crust']);
  assert.deepEqual(bucketsOf(['old school death metal', 'osdm']), ['death-metal']);
  assert.deepEqual(bucketsOf(['hardcore punk', 'oi']), ['hardcore-punk']);
});

test('релиз без seed-тегов не попадает никуда', () => {
  assert.deepEqual(bucketsOf(['ambient', 'drone']), []);
});

test('кроссовер-релиз питает статистику всех подходящих бакетов', () => {
  assert.deepEqual(bucketsOf(['crust', 'crust punk', 'd-beat', 'hardcore punk']), [
    'crust',
    'hardcore-punk',
  ]);
});

test('совпадение регистронезависимо', () => {
  assert.deepEqual(bucketsOf(['Crust Punk', 'D-Beat']), ['crust']);
});
