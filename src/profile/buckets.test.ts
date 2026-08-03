import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUCKETS, bucketOf } from './buckets.ts';

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

test('релиз попадает в бакет по seed-тегу', () => {
  assert.equal(bucketOf(['d-beat', 'crust punk']), 'crust');
  assert.equal(bucketOf(['old school death metal', 'osdm']), 'death-metal');
  assert.equal(bucketOf(['hardcore punk', 'oi']), 'hardcore-punk');
});

test('релиз без seed-тегов не попадает никуда', () => {
  assert.equal(bucketOf(['ambient', 'drone']), null);
});

test('при попадании в несколько бакетов побеждает тот, где больше совпадений', () => {
  assert.equal(bucketOf(['crust', 'crust punk', 'd-beat', 'death metal']), 'crust');
});
