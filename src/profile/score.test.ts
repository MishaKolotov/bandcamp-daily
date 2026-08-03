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
  // Оба кандидата должны сами пройти порог совпадения тегов, иначе тест
  // проверяет отбраковку по полу, а не популярность: hype несёт только
  // опорный тег (0.5 — впритык проходит порог) плюс запредельный хайп,
  // match несёт опорный и топовый не-опорный тег без единого "коллекта".
  const hype = score(candidate({ tags: ['crust'], alsoCollected: 1_000_000_000 }), bucket, {});
  const match = score(candidate({ tags: ['crust', 'discharge worship'] }), bucket, {});
  assert.equal(hype.rejected, false);
  // Популярность капается на 0.5 (см. Math.min в score.ts): даже миллиард
  // "also collected" не даёт больше tagScore(0.5) + 0.5 = 1 — если бы
  // коэффициент или потолок разъехались, эта проверка бы поймала.
  assert.equal(hype.total, 1);
  assert.ok(match.total > hype.total);
});

test('отскипанные ранее теги штрафуются', () => {
  const plain = score(candidate({ tags: ['crust'] }), bucket, {});
  const penalized = score(candidate({ tags: ['crust'] }), bucket, {
    tagPenalties: { crust: 2 },
  });
  assert.ok(penalized.total < plain.total);
});

test('отбраковка по штрафам всегда репортит total: 0, а не отрицательное число', () => {
  // crust даёт tagScore 0.5, штраф за отскип с весом 10 срезает
  // 0.25 * 10 = 2.5 очка — итог уходит в минус (-2), но total должен
  // репортиться ровно как 0, той же формой, что и отбраковка по полу.
  const result = score(candidate({ tags: ['crust'] }), bucket, {
    tagPenalties: { crust: 10 },
  });
  assert.equal(result.rejected, true);
  assert.equal(result.total, 0);
});

test('сильное совпадение переживает большой штраф по опорному тегу', () => {
  // crust + discharge worship = STRONG_MATCH (1.5). Опорный тег несёт
  // каждый релиз бакета по построению, так что штраф за скипы копится
  // именно на нём быстрее всего — 20 скипов без потолка дают 0.25*20=5,
  // что зарежет даже идеальное совпадение в ноль. С потолком в 1 сильное
  // совпадение должно пережить это (1.5 - 1 = 0.5 > 0).
  const result = score(candidate({ tags: ['crust', 'discharge worship'] }), bucket, {
    tagPenalties: { crust: 20 },
  });
  assert.equal(result.rejected, false);
});

test('совпадение по каноническому тегу: профиль и кандидат пишут тег по-разному', () => {
  // data/profile.json хозяин правит руками — он мог вписать тег с дефисом,
  // а Bandcamp тегировал конкретный релиз слитно (или наоборот). Совпадение
  // не должно теряться из-за разницы в написании.
  const bucketAlt: BucketProfile = {
    tags: { crust: 0.5, 'crust-punk': 0.8 },
    stopTags: [],
    releaseCount: 10,
    weightSum: 10,
  };
  const matched = score(candidate({ tags: ['crust', 'crustpunk'] }), bucketAlt, {});
  assert.equal(matched.rejected, false);
  assert.equal(matched.total, 1.3);
  assert.deepEqual(matched.reasons, ['crustpunk', 'crust']);
});

test('стоп-тег ловит кандидата, даже если тот написан иначе, чем в профиле', () => {
  const bucketAlt: BucketProfile = {
    tags: { crust: 0.5, 'discharge worship': 1 },
    stopTags: ['death-core'],
    releaseCount: 10,
    weightSum: 10,
  };
  // 'crust' (0.5) ниже STRONG_MATCH (1.5) — слабое совпадение, стоп-тег
  // должен отбраковать релиз целиком, даже несмотря на разницу в написании
  // ('deathcore' у кандидата против 'death-core' в profile.json).
  const weak = score(candidate({ tags: ['crust', 'deathcore'] }), bucketAlt, {});
  assert.equal(weak.rejected, true);
});

test('в reasons попадают совпавшие теги, сильнейшие первыми', () => {
  const result = score(candidate({ tags: ['raw punk', 'crust', 'discharge worship'] }), bucket, {});
  // discharge worship (1) тяжелее опорного crust (0.5), который в новой форме профиля
  // больше не гарантированно самый тяжёлый совпавший тег.
  assert.deepEqual(result.reasons.slice(0, 2), ['discharge worship', 'crust']);
});
