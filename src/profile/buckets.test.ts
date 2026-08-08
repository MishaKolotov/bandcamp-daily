import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUCKETS, bucketsOf, hubSampleTags, type BucketDef } from './buckets.ts';
import { canonicalizeTag } from '../lib/tags.ts';

test('описаны ровно четыре бакета с человекочитаемыми именами', () => {
  assert.deepEqual(
    BUCKETS.map((b) => b.id),
    ['crust', 'death-metal', 'hardcore-punk', 'black-metal'],
  );
  for (const bucket of BUCKETS) {
    assert.ok(bucket.title.length > 0, `${bucket.id}: пустое title`);
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

test('написание тега через дефис, пробел или слитно — один и тот же тег для бакета', () => {
  // Прямое требование хозяина: 'crust punk' / 'crust-punk' / 'crustpunk' и
  // 'd-beat' / 'dbeat' / 'd beat' должны относить релиз в бакет одинаково
  // надёжно, независимо от того, как именно Bandcamp записал тег.
  assert.deepEqual(bucketsOf(['crustpunk']), ['crust']);
  assert.deepEqual(bucketsOf(['crust-punk']), ['crust']);
  assert.deepEqual(bucketsOf(['dbeat']), ['crust']);
  assert.deepEqual(bucketsOf(['d beat']), ['crust']);
  assert.deepEqual(bucketsOf(['hardcorepunk']), ['hardcore-punk']);
  assert.deepEqual(bucketsOf(['hardcore-punk']), ['hardcore-punk']);
});

test('релиз без составного тега, только с голым словом-корнем, всё ещё матчится по-старому', () => {
  // 'hardcore'/'punk' — намеренно отдельный омонимный сигнал от 'hardcore
  // punk' (см. комментарий у seedTags бакета hardcore-punk); релиз без
  // составного тега вообще не должен внезапно перестать матчиться после
  // введения канонизации — она только объединяет НАПИСАНИЯ одного тега,
  // а не сближает разные теги между собой.
  assert.deepEqual(bucketsOf(['hardcore']), ['hardcore-punk']);
  assert.deepEqual(bucketsOf(['punk']), ['hardcore-punk']);
  assert.deepEqual(bucketsOf(['ambient', 'hardcorewave']), []);
});

test('seed-теги бакета не содержат двух записей одного и того же канонического тега', () => {
  // Раньше список специально перечислял написания-варианты ('crust punk' и
  // 'crustpunk', 'd-beat' и 'dbeat', 'hardcore punk' и 'hardcore-punk') —
  // с canonicalizeTag это избыточно и рискует разойтись, если кто-то
  // дополнит только одно из двух написаний. Регресс на то, что дубли не
  // вернутся.
  for (const bucket of BUCKETS) {
    const seenBy = new Map<string, string>();
    for (const tag of bucket.seedTags) {
      const key = canonicalizeTag(tag);
      const prior = seenBy.get(key);
      assert.equal(
        prior,
        undefined,
        `${bucket.id}: "${tag}" и "${prior}" — одно и то же после канонизации (${key})`,
      );
      seenBy.set(key, tag);
    }
  }
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
  // ИЗМЕНЕНО этой задачей (канонизация написаний тегов): раньше в этом
  // месте проверялось, что ВСЕ 3 выбранных тега составные (есть пробел
  // или дефис) — это держалось только на том, что seedTags бакета
  // содержали 'hardcore punk' И 'hardcore-punk' как две отдельные записи
  // одного и того же тега (см. buckets.ts до этой правки). После дедупа
  // написаний в бакете остаётся ровно 2 по-настоящему составных тега
  // ('hardcore punk', 'raw punk') — они обязаны попасть в выборку первыми,
  // третьим местом добирается лучший из оставшихся однословных
  // ('powerviolence' — не омоним, в отличие от 'punk'/'hardcore').
  assert.deepEqual(picked.slice(0, 2), ['hardcore punk', 'raw punk']);
  assert.equal(picked[2], 'powerviolence');
});

test('hubSampleTags добирает голые теги, если составных не хватает до limit', () => {
  const thin: BucketDef = {
    id: 'crust',
    title: 'TEST',
    seedTags: Object.freeze(['onlybareword', 'also bare-ish']),
  };
  const picked = hubSampleTags(thin, 3);
  assert.deepEqual(picked, ['also bare-ish', 'onlybareword']);
});

test('hubSampleTags уважает limit', () => {
  const deathMetal = BUCKETS.find((b) => b.id === 'death-metal')!;
  assert.equal(hubSampleTags(deathMetal, 2).length, 2);
});
