import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUCKETS, bucketsOf, hubSampleTags, type BucketDef } from './buckets.ts';

test('описаны ровно четыре бакета с каналами', () => {
  assert.deepEqual(
    BUCKETS.map((b) => b.id),
    ['crust', 'death-metal', 'hardcore-punk', 'black-metal'],
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

test('голые punk и hardcore относят релиз в hardcore-punk', () => {
  assert.deepEqual(bucketsOf(['punk']), ['hardcore-punk']);
  assert.deepEqual(bucketsOf(['hardcore']), ['hardcore-punk']);
});

test('релиз чёрного металла попадает в бакет black-metal', () => {
  assert.deepEqual(bucketsOf(['black metal', 'raw']), ['black-metal']);
  assert.deepEqual(bucketsOf(['raw black metal']), ['black-metal']);
});

test('hubSampleTags предпочитает составные seed-теги голым однословным', () => {
  const hardcorePunk = BUCKETS.find((b) => b.id === 'hardcore-punk')!;
  const picked = hubSampleTags(hardcorePunk, 3);
  assert.equal(picked.length, 3);
  // Голые 'punk' и 'hardcore' — Bandcamp-омонимы с хабом на сотни тысяч
  // релизов (см. живой прогон); хаб-сэмплирование не должно их трогать,
  // пока есть составные seed-теги того же бакета.
  assert.ok(!picked.includes('punk'), `punk не должен попасть в хаб-сэмпл: ${picked}`);
  assert.ok(!picked.includes('hardcore'), `hardcore не должен попасть в хаб-сэмпл: ${picked}`);
  for (const tag of picked) {
    assert.ok(/[\s-]/.test(tag), `хаб-тег "${tag}" должен быть составным`);
  }
});

test('hubSampleTags добирает голые теги, если составных не хватает до limit', () => {
  const thin: BucketDef = {
    id: 'crust',
    channelTitle: 'TEST',
    channelEnv: 'TEST_CHANNEL_ID',
    seedTags: Object.freeze(['onlybareword', 'also bare-ish']),
  };
  const picked = hubSampleTags(thin, 3);
  assert.deepEqual(picked, ['also bare-ish', 'onlybareword']);
});

test('hubSampleTags уважает limit', () => {
  const deathMetal = BUCKETS.find((b) => b.id === 'death-metal')!;
  assert.equal(hubSampleTags(deathMetal, 2).length, 2);
});
