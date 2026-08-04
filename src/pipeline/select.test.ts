import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candidate } from '../bandcamp/types.ts';
import type { BucketProfile } from '../profile/build.ts';
import { selectForBucket, type PoolOutcome } from './select.ts';

const bucket: BucketProfile = {
  tags: { crust: 1, 'd-beat': 0.8 },
  stopTags: ['deathcore'],
  releaseCount: 10,
  weightSum: 12,
};

const candidate = (itemId: number, over: Partial<Candidate> = {}): Candidate => ({
  itemId,
  url: `https://x.test/album/${itemId}`,
  title: `T${itemId}`,
  artist: `A${itemId}`,
  label: null,
  tags: ['crust'],
  releasedAt: '2026-08-01',
  artUrl: null,
  alsoCollected: 0,
  origin: 'fresh',
  ...over,
});

/** Сужает PoolOutcome до варианта 'picked' или роняет тест — избавляет каждый тест от ручного if-narrowing. */
function picked(outcome: PoolOutcome) {
  if (outcome.status !== 'picked') throw new Error(`ожидали 'picked', получили '${outcome.status}'`);
  return outcome;
}

test('на бакет выбирается по одному свежему и одному архивному', () => {
  const result = selectForBucket({
    bucket,
    seedTags: ['crust'],
    hardRejectTags: [],
    fresh: [candidate(1), candidate(2)],
    archive: [candidate(3, { origin: 'archive' })],
    seen: new Set(),
    context: {},
    alternativesCount: 3,
  });
  assert.equal(picked(result.fresh).candidate.origin, 'fresh');
  assert.equal(picked(result.archive).candidate.origin, 'archive');
});

test('показанное ранее (по URL) не предлагается снова', () => {
  const result = selectForBucket({
    bucket,
    seedTags: ['crust'],
    hardRejectTags: [],
    fresh: [candidate(1)],
    archive: [],
    seen: new Set(['https://x.test/album/1']),
    context: {},
    alternativesCount: 3,
  });
  // Пул был непустой (1 кандидат), но всё отсеялось — «не подошло», не «не предлагали».
  assert.equal(result.fresh.status, 'no-match');
  // Архивный пул пуст сам по себе — «не предлагали».
  assert.equal(result.archive.status, 'not-offered');
});

test('itemId кандидата, показанного через другой источник, не спасает его от seen-фильтра по URL', () => {
  // Тот же URL, но itemId не совпадает с тем, что был при показе (imитация
  // релиза, который в прошлый раз пришёл с хешем URL из fresh.ts, а теперь
  // всплыл с настоящим item_id Bandcamp через Discover).
  const result = selectForBucket({
    bucket,
    seedTags: ['crust'],
    hardRejectTags: [],
    fresh: [candidate(999, { url: 'https://x.test/album/1' })],
    archive: [],
    seen: new Set(['https://x.test/album/1']),
    context: {},
    alternativesCount: 3,
  });
  assert.equal(result.fresh.status, 'no-match');
});

test('отбракованные скорингом не попадают в выбор', () => {
  const result = selectForBucket({
    bucket,
    seedTags: ['crust'],
    hardRejectTags: [],
    fresh: [candidate(1, { tags: ['ambient'] })],
    archive: [],
    seen: new Set(),
    context: {},
    alternativesCount: 3,
  });
  assert.equal(result.fresh.status, 'no-match');
  assert.equal(result.archive.status, 'not-offered');
});

test('оба пула пусты на входе — оба «не предлагали», а не «не подошло»', () => {
  const result = selectForBucket({
    bucket,
    seedTags: ['crust'],
    hardRejectTags: [],
    fresh: [],
    archive: [],
    seen: new Set(),
    context: {},
    alternativesCount: 3,
  });
  assert.equal(result.fresh.status, 'not-offered');
  assert.equal(result.archive.status, 'not-offered');
});

test('побеждает кандидат с большим скором, остальные идут в запас', () => {
  const result = selectForBucket({
    bucket,
    seedTags: ['crust'],
    hardRejectTags: [],
    fresh: [candidate(1, { tags: ['crust'] }), candidate(2, { tags: ['crust', 'd-beat'] })],
    archive: [],
    seen: new Set(),
    context: {},
    alternativesCount: 3,
  });
  const fresh = picked(result.fresh);
  assert.equal(fresh.candidate.itemId, 2);
  assert.deepEqual(fresh.alternatives.map((c) => c.itemId), [1]);
});

test('в выбор кладутся совпавшие теги для строки «почему»', () => {
  const result = selectForBucket({
    bucket,
    seedTags: ['crust'],
    hardRejectTags: [],
    fresh: [candidate(1, { tags: ['crust', 'd-beat'] })],
    archive: [],
    seen: new Set(),
    context: {},
    alternativesCount: 3,
  });
  assert.deepEqual(picked(result.fresh).matchedTags, ['crust', 'd-beat']);
});

test('запас ограничен alternativesCount', () => {
  const result = selectForBucket({
    bucket,
    seedTags: ['crust'],
    hardRejectTags: [],
    fresh: [candidate(1), candidate(2), candidate(3), candidate(4), candidate(5)],
    archive: [],
    seen: new Set(),
    context: {},
    alternativesCount: 2,
  });
  assert.equal(picked(result.fresh).alternatives.length, 2);
});

test('ничья по скору решается детерминированно — не зависит от порядка кандидатов на входе', () => {
  const a = candidate(10);
  const b = candidate(20);
  const forward = selectForBucket({
    bucket,
    seedTags: ['crust'],
    hardRejectTags: [],
    fresh: [a, b],
    archive: [],
    seen: new Set(),
    context: {},
    alternativesCount: 3,
  });
  const backward = selectForBucket({
    bucket,
    seedTags: ['crust'],
    hardRejectTags: [],
    fresh: [b, a],
    archive: [],
    seen: new Set(),
    context: {},
    alternativesCount: 3,
  });
  assert.equal(picked(forward.fresh).candidate.itemId, picked(backward.fresh).candidate.itemId);
});

test('дубликат по URL внутри одного пула схлопывается детерминированно (меньший itemId), а не по порядку массива', () => {
  const lower = candidate(5, { url: 'https://x.test/album/dup' });
  const higher = candidate(500, { url: 'https://x.test/album/dup' });
  const forward = selectForBucket({
    bucket,
    seedTags: ['crust'],
    hardRejectTags: [],
    fresh: [lower, higher],
    archive: [],
    seen: new Set(),
    context: {},
    alternativesCount: 3,
  });
  const backward = selectForBucket({
    bucket,
    seedTags: ['crust'],
    hardRejectTags: [],
    fresh: [higher, lower],
    archive: [],
    seen: new Set(),
    context: {},
    alternativesCount: 3,
  });
  assert.equal(picked(forward.fresh).candidate.itemId, 5);
  assert.equal(picked(backward.fresh).candidate.itemId, 5);
  assert.equal(picked(forward.fresh).alternatives.length, 0);
});

test('один и тот же релиз, пришедший и в свежак, и в архив, отдаётся владельцу только один раз — выигрывает свежак', () => {
  const sharedUrl = 'https://x.test/album/shared';
  const result = selectForBucket({
    bucket,
    seedTags: ['crust'],
    hardRejectTags: [],
    fresh: [candidate(1, { url: sharedUrl, origin: 'fresh' })],
    archive: [candidate(2, { url: sharedUrl, origin: 'archive' })],
    seen: new Set(),
    context: {},
    alternativesCount: 3,
  });
  assert.equal(picked(result.fresh).candidate.origin, 'fresh');
  // Архивный пул был непустой (1 кандидат), но единственный кандидат уже
  // занят свежаком — «не подошло», а не «не предлагали».
  assert.equal(result.archive.status, 'no-match');
});

test('запасной кандидат одного пула не повторяет то, что уже выбрано как основной кандидат другого пула', () => {
  const bUrl = 'https://x.test/album/both-pools';
  // A — лучший свежий кандидат (два совпавших тега), B — второй по скору
  // свежий (один тег), и B же — единственный (и потому лучший) архивный.
  const freshA = candidate(1, { tags: ['crust', 'd-beat'] });
  const freshB = candidate(2, { url: bUrl, tags: ['crust'] });
  const archiveB = candidate(3, { url: bUrl, tags: ['crust'], origin: 'archive' });

  const result = selectForBucket({
    bucket,
    seedTags: ['crust'],
    hardRejectTags: [],
    fresh: [freshA, freshB],
    archive: [archiveB],
    seen: new Set(),
    context: {},
    alternativesCount: 3,
  });

  const fresh = picked(result.fresh);
  const archive = picked(result.archive);
  assert.equal(fresh.candidate.itemId, 1);
  assert.equal(archive.candidate.url, bUrl);
  // B фигурирует как основной архивный пик — свежак не должен предлагать
  // его повторно как «другой кандидат».
  assert.deepEqual(fresh.alternatives, []);
});

// ---------------------------------------------------------------------------
// Hard-reject: см. hardRejectTags в ../profile/score.ts. Проверяем именно то,
// что до фикса не работало через bucket.stopTags — кандидат с сильным
// совпадением по тегам, но несущий hard-reject тег, не должен побеждать даже
// более слабого, но настоящего кандидата.
// ---------------------------------------------------------------------------

test('кандидат с hard-reject тегом не выбирается, даже если он сильнее остальных по скору', () => {
  const compilation = candidate(1, { tags: ['crust', 'd-beat', 'compilation'] });
  const genuine = candidate(2, { tags: ['crust'] });

  const result = selectForBucket({
    bucket,
    seedTags: ['crust'],
    hardRejectTags: ['compilation'],
    fresh: [compilation, genuine],
    archive: [],
    seen: new Set(),
    context: {},
    alternativesCount: 3,
  });

  const fresh = picked(result.fresh);
  assert.equal(fresh.candidate.itemId, 2, 'слабейший настоящий релиз обязан победить, компиляция вообще не в игре');
  assert.deepEqual(fresh.alternatives, [], 'компиляция не должна попасть даже в запас');
});

test('кандидат с hard-reject тегом отсеивается из обоих пулов и не оставляет бакет без карточки, если есть кем заменить', () => {
  const compilation = candidate(1, { tags: ['crust', 'd-beat', 'compilation'] });

  const result = selectForBucket({
    bucket,
    seedTags: ['crust'],
    hardRejectTags: ['compilation'],
    fresh: [compilation],
    archive: [],
    seen: new Set(),
    context: {},
    alternativesCount: 3,
  });

  // Пул был непустой (1 кандидат), но единственный кандидат hard-reject —
  // «не подошло», не «не предлагали» (та же семантика, что и у обычной
  // отбраковки скорингом).
  assert.equal(result.fresh.status, 'no-match');
});
