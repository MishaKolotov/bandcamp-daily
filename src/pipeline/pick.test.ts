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

test('один и тот же релиз в двух бакетах не задваивается — остаётся сильнейшее совпадение', () => {
  const shared = ['crust', 'd-beat'];
  const best = pickBest({
    ...base,
    buckets: [
      {
        id: 'crust',
        profile: profileOf({ crust: 0.5, 'd-beat': 1 }),
        seedTags: ['crust'],
        fresh: [candidate('https://x.test/same', shared)],
        archive: [],
      },
      {
        id: 'hardcore-punk',
        profile: profileOf({ crust: 0.2, punk: 0.5 }),
        seedTags: ['crust'],
        fresh: [candidate('https://x.test/same', shared)],
        archive: [],
      },
    ],
  });
  assert.equal(best?.bucket, 'crust');
  assert.deepEqual(best?.alternatives, []);
});
