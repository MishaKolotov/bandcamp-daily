import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candidate } from '../bandcamp/types.ts';
import type { BucketProfile } from './build.ts';
import { score } from './score.ts';

// Форма профиля из build.ts: не-опорные теги нормализованы к максимуму 1,
// опорный тег бакета (здесь — crust), если пережил порог minReleases,
// зафиксирован на 0.5. discharge worship — самый характерный не-опорный тег (вес 1),
// raw punk — менее характерный не-опорный тег.
const bucket: BucketProfile = {
  tags: { crust: 0.5, 'discharge worship': 1, 'raw punk': 0.4 },
  stopTags: ['deathcore', 'metalcore'],
  releaseCount: 50,
  weightSum: 60,
};

const candidate = (over: Partial<Candidate>): Candidate => ({
  itemId: 1,
  url: 'https://x.bandcamp.com/album/a',
  title: 'A',
  artist: 'B',
  label: null,
  tags: [],
  releasedAt: '2026-08-01',
  artUrl: null,
  alsoCollected: 0,
  origin: 'fresh',
  ...over,
});

test('совпадение тегов даёт положительный скор', () => {
  const result = score(candidate({ tags: ['crust', 'discharge worship'] }), bucket, {});
  // Опорный тег (0.5) + топовый не-опорный тег (1) — потолок парного совпадения.
  assert.equal(result.total, 1.5);
  assert.equal(result.rejected, false);
});

test('релиз без единого знакомого тега отбраковывается', () => {
  const result = score(candidate({ tags: ['ambient'] }), bucket, {});
  assert.equal(result.rejected, true);
});

test('стоп-тег при слабом совпадении отбраковывает релиз', () => {
  const result = score(candidate({ tags: ['raw punk', 'deathcore'] }), bucket, {});
  assert.equal(result.rejected, true);
});

test('стоп-тег при сильном совпадении только штрафует', () => {
  const strong = score(candidate({ tags: ['crust', 'discharge worship', 'raw punk'] }), bucket, {});
  const withStop = score(
    candidate({ tags: ['crust', 'discharge worship', 'raw punk', 'metalcore'] }),
    bucket,
    {},
  );
  assert.equal(withStop.rejected, false);
  assert.ok(withStop.total < strong.total);
});

test('одинокий опорный тег не отбраковывается, но проигрывает совпадению со специфичным тегом', () => {
  // Это и есть суть пересчёта порогов под новую форму профиля: опорный тег
  // (0.5) один погоды не делает и не убивает релиз, а сумма с топовым
  // не-опорным тегом (1) — ощутимо сильнее.
  const seedOnly = score(candidate({ tags: ['crust'] }), bucket, {});
  const seedPlusSpecific = score(candidate({ tags: ['crust', 'discharge worship'] }), bucket, {});
  assert.equal(seedOnly.rejected, false);
  assert.ok(seedPlusSpecific.total > seedOnly.total);
});

test('знакомый лейбл поднимает скор', () => {
  const plain = score(candidate({ tags: ['crust'] }), bucket, {});
  const known = score(candidate({ tags: ['crust'], label: 'La Vida Es Un Mus' }), bucket, {
    labels: { 'la vida es un mus': 1 },
  });
  assert.ok(known.total > plain.total);
});

test('популярность добавляет мало и не перебивает совпадение по тегам', () => {
  const hype = score(candidate({ tags: ['raw punk'], alsoCollected: 5000 }), bucket, {});
  const match = score(candidate({ tags: ['crust', 'discharge worship'] }), bucket, {});
  assert.ok(match.total > hype.total);
});

test('отскипанные ранее теги штрафуются', () => {
  const plain = score(candidate({ tags: ['crust'] }), bucket, {});
  const penalized = score(candidate({ tags: ['crust'] }), bucket, {
    tagPenalties: { crust: 2 },
  });
  assert.ok(penalized.total < plain.total);
});

test('в reasons попадают совпавшие теги, сильнейшие первыми', () => {
  const result = score(candidate({ tags: ['raw punk', 'crust', 'discharge worship'] }), bucket, {});
  // discharge worship (1) тяжелее опорного crust (0.5), который в новой форме профиля
  // больше не гарантированно самый тяжёлый совпавший тег.
  assert.deepEqual(result.reasons.slice(0, 2), ['discharge worship', 'crust']);
});
