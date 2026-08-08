import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BucketId, Candidate } from '../bandcamp/types.ts';
import type { BucketProfile } from '../profile/build.ts';
import { pickBest, type BucketInput } from './pick.ts';

const candidate = (url: string, tags: string[], over: Partial<Candidate> = {}): Candidate => ({
  itemId: 1,
  url,
  title: 'T',
  artist: 'A',
  label: null,
  tags,
  releasedAt: '2026-08-01',
  artUrl: null,
  alsoCollected: 0,
  origin: 'fresh',
  ...over,
});

/** Профиль, где перечисленные теги весят заданное — чтобы total был предсказуем. */
const profileOf = (tags: Record<string, number>): BucketProfile => ({
  tags,
  stopTags: [],
  releaseCount: 10,
  weightSum: 1,
});

const bucketInput = (
  id: BucketId,
  tags: string[],
  seedTags: string[],
  weights: Record<string, number>,
): BucketInput => ({
  id,
  profile: profileOf(weights),
  seedTags,
  fresh: [candidate(`https://x.test/${id}`, tags)],
  archive: [],
});

const base = {
  hardRejectTags: [] as readonly string[],
  seen: new Set<string>(),
  context: {},
  alternativesCount: 3,
  minTotal: 0,
};

test('побеждает кандидат с максимальным total, независимо от бакета', () => {
  const best = pickBest({
    ...base,
    buckets: [
      bucketInput('crust', ['crust'], ['crust'], { crust: 0.5 }),
      bucketInput('black-metal', ['black metal', 'raw black metal'], ['black metal'], {
        'black metal': 0.5,
        'raw black metal': 1,
      }),
    ],
  });
  assert.equal(best?.bucket, 'black-metal');
});

test('ниже порога — не возвращает ничего', () => {
  const best = pickBest({
    ...base,
    minTotal: 99,
    buckets: [bucketInput('crust', ['crust'], ['crust'], { crust: 0.5 })],
  });
  assert.equal(best, null);
});

test('бакет прошлого пика исключается целиком', () => {
  const best = pickBest({
    ...base,
    excludeBucket: 'black-metal',
    buckets: [
      bucketInput('crust', ['crust'], ['crust'], { crust: 0.5 }),
      bucketInput('black-metal', ['black metal', 'raw black metal'], ['black metal'], {
        'black metal': 0.5,
        'raw black metal': 1,
      }),
    ],
  });
  assert.equal(best?.bucket, 'crust');
});

test('запас «другой» берётся только из бакета победителя', () => {
  const best = pickBest({
    ...base,
    buckets: [
      {
        id: 'crust',
        profile: profileOf({ crust: 0.5, 'd-beat': 1 }),
        seedTags: ['crust'],
        fresh: [
          candidate('https://x.test/a', ['crust', 'd-beat']),
          candidate('https://x.test/b', ['crust']),
        ],
        archive: [],
      },
      bucketInput('death-metal', ['death metal'], ['death metal'], { 'death metal': 0.5 }),
    ],
  });
  assert.equal(best?.candidate.url, 'https://x.test/a');
  assert.deepEqual(
    best?.alternatives.map((c) => c.url),
    ['https://x.test/b'],
  );
});

test('уже показанное не рассматривается', () => {
  const best = pickBest({
    ...base,
    seen: new Set(['https://x.test/crust']),
    buckets: [bucketInput('crust', ['crust'], ['crust'], { crust: 0.5 })],
  });
  assert.equal(best, null);
});

test('релиз, попавший и в свежак, и в архив, не становится сам себе «другим кандидатом»', () => {
  // Это тот случай, ради которого дедуп по URL вообще существует, и
  // единственный, где его отсутствие ВИДНО снаружи: один и тот же релиз
  // законно приходит из двух источников (подписка выпустила его сегодня — и
  // он же набрал голоса соседей в архивном пуле), причём с разными itemId
  // (у архивного это хеш URL, а не настоящий id Bandcamp). Без схлопывания
  // он занял бы и первое место, и первую строчку запаса — владелец нажал бы
  // «другой» и увидел ровно тот же альбом.
  const twice = ['crust', 'd-beat'];
  const best = pickBest({
    ...base,
    buckets: [
      {
        id: 'crust',
        profile: profileOf({ crust: 0.5, 'd-beat': 1 }),
        seedTags: ['crust'],
        fresh: [candidate('https://x.test/same', twice)],
        archive: [candidate('https://x.test/same', twice, { itemId: 777, origin: 'archive' })],
      },
    ],
  });
  assert.equal(best?.candidate.url, 'https://x.test/same');
  assert.deepEqual(
    best?.alternatives.map((c) => c.url),
    [],
    'дубль того же URL не имеет права попасть в запас «другой»',
  );
});

test('один и тот же релиз в двух бакетах достаётся тому, где совпадение сильнее', () => {
  const shared = ['crust', 'd-beat'];
  const best = pickBest({
    ...base,
    buckets: [
      {
        // Слабее: копия переживает скоринг (tagScore ровно 0.5 = MATCH_FLOOR,
        // проверка строгая `<`, опорный тег есть), но набирает меньше.
        id: 'hardcore-punk',
        profile: profileOf({ crust: 0.5, punk: 0.5 }),
        seedTags: ['crust'],
        fresh: [candidate('https://x.test/same', shared)],
        archive: [],
      },
      {
        id: 'crust',
        profile: profileOf({ crust: 0.5, 'd-beat': 1 }),
        seedTags: ['crust'],
        fresh: [candidate('https://x.test/same', shared)],
        archive: [],
      },
    ],
  });
  assert.equal(best?.bucket, 'crust', 'кроссовер достаётся бакету, чей профиль совпал сильнее');
});
