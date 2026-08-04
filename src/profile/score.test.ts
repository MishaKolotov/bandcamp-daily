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
// В этом фикстурном профиле опорный тег бакета ровно один — 'crust' (см.
// комментарий выше про вес 0.5 в build.ts). 'discharge worship' и
// 'raw punk' — производные теги, а не опорные, несмотря на то что 'raw
// punk' в реальном buckets.ts тоже seed-тег crust — эта фикстура его
// намеренно моделирует как производный, чтобы отличать поведение по весу
// от поведения по опорности.
const seedTags = ['crust'];
// Большинство тестов этого файла не про hard-reject вовсе — им нужен пустой
// список, чтобы не завести случайный сюрприз, но `score()` требует его на
// каждом вызове явно (см. комментарий у аргумента `hardRejectTags` в
// score.ts) — забыть передать и получить старое поведение молча нельзя,
// это ошибка компиляции.
const noHardReject: readonly string[] = [];

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
  const result = score(candidate({ tags: ['crust', 'discharge worship'] }), bucket, seedTags, noHardReject, {});
  // Опорный тег (0.5) + топовый не-опорный тег (1) — потолок парного совпадения.
  assert.equal(result.total, 1.5);
  assert.equal(result.rejected, false);
  assert.equal(result.hardRejected, false);
});

test('релиз без единого знакомого тега отбраковывается', () => {
  const result = score(candidate({ tags: ['ambient'] }), bucket, seedTags, noHardReject, {});
  assert.equal(result.rejected, true);
  assert.equal(result.hardRejected, false);
});

test('стоп-тег при слабом совпадении отбраковывает релиз', () => {
  const result = score(candidate({ tags: ['crust', 'raw punk', 'deathcore'] }), bucket, seedTags, noHardReject, {});
  assert.equal(result.rejected, true);
  assert.equal(result.hardRejected, false);
});

test('стоп-тег при сильном совпадении только штрафует', () => {
  const strong = score(
    candidate({ tags: ['crust', 'discharge worship', 'raw punk'] }),
    bucket,
    seedTags,
    noHardReject,
    {},
  );
  const withStop = score(
    candidate({ tags: ['crust', 'discharge worship', 'raw punk', 'metalcore'] }),
    bucket,
    seedTags,
    noHardReject,
    {},
  );
  assert.equal(withStop.rejected, false);
  assert.ok(withStop.total < strong.total);
});

test('одинокий опорный тег не отбраковывается, но проигрывает совпадению со специфичным тегом', () => {
  // Это и есть суть пересчёта порогов под новую форму профиля: опорный тег
  // (0.5) один погоды не делает и не убивает релиз, а сумма с топовым
  // не-опорным тегом (1) — ощутимо сильнее.
  const seedOnly = score(candidate({ tags: ['crust'] }), bucket, seedTags, noHardReject, {});
  const seedPlusSpecific = score(
    candidate({ tags: ['crust', 'discharge worship'] }),
    bucket,
    seedTags,
    noHardReject,
    {},
  );
  assert.equal(seedOnly.rejected, false);
  assert.ok(seedPlusSpecific.total > seedOnly.total);
});

test('знакомый лейбл поднимает скор', () => {
  const plain = score(candidate({ tags: ['crust'] }), bucket, seedTags, noHardReject, {});
  const known = score(candidate({ tags: ['crust'], label: 'La Vida Es Un Mus' }), bucket, seedTags, noHardReject, {
    labels: { 'la vida es un mus': 1 },
  });
  assert.ok(known.total > plain.total);
});

test('популярность релиза на скор не влияет вообще', () => {
  // alsoCollected заполняется только у позиций из коллекции владельца, а
  // кандидаты приходят из Discover и от соседей — там это поле всегда 0
  // (см. комментарий в score.ts). Пока брать число неоткуда, скор обязан
  // быть к нему полностью безразличен: иначе в формуле снова заведётся
  // ветка, которая по факту никогда не срабатывает.
  const hype = score(candidate({ tags: ['crust'], alsoCollected: 1_000_000_000 }), bucket, seedTags, noHardReject, {});
  const quiet = score(candidate({ tags: ['crust'], alsoCollected: 0 }), bucket, seedTags, noHardReject, {});
  assert.equal(hype.rejected, false);
  assert.equal(hype.total, quiet.total);
  assert.equal(hype.total, 0.5);

  // И совпадение по тегам по-прежнему решает: релиз с характерным тегом
  // обгоняет релиз с одним лишь опорным, сколько бы его ни «собрали».
  const match = score(candidate({ tags: ['crust', 'discharge worship'] }), bucket, seedTags, noHardReject, {});
  assert.ok(match.total > hype.total);
});

test('отскипанные ранее теги штрафуются', () => {
  const plain = score(candidate({ tags: ['crust'] }), bucket, seedTags, noHardReject, {});
  const penalized = score(candidate({ tags: ['crust'] }), bucket, seedTags, noHardReject, {
    tagPenalties: { crust: 2 },
  });
  assert.ok(penalized.total < plain.total);
});

test('отбраковка по штрафам всегда репортит total: 0, а не отрицательное число', () => {
  // crust даёт tagScore 0.5, штраф за отскип с весом 10 срезает
  // 0.25 * 10 = 2.5 очка — итог уходит в минус (-2), но total должен
  // репортиться ровно как 0, той же формой, что и отбраковка по полу.
  const result = score(candidate({ tags: ['crust'] }), bucket, seedTags, noHardReject, {
    tagPenalties: { crust: 10 },
  });
  assert.equal(result.rejected, true);
  assert.equal(result.total, 0);
  assert.equal(result.hardRejected, false);
});

test('сильное совпадение переживает большой штраф по опорному тегу', () => {
  // crust + discharge worship = STRONG_MATCH (1.5). Опорный тег несёт
  // каждый релиз бакета по построению, так что штраф за скипы копится
  // именно на нём быстрее всего — 20 скипов без потолка дают 0.25*20=5,
  // что зарежет даже идеальное совпадение в ноль. С потолком в 1 сильное
  // совпадение должно пережить это (1.5 - 1 = 0.5 > 0).
  const result = score(candidate({ tags: ['crust', 'discharge worship'] }), bucket, seedTags, noHardReject, {
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
  const matched = score(candidate({ tags: ['crust', 'crustpunk'] }), bucketAlt, seedTags, noHardReject, {});
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
  const weak = score(candidate({ tags: ['crust', 'deathcore'] }), bucketAlt, seedTags, noHardReject, {});
  assert.equal(weak.rejected, true);
});

test('в reasons попадают совпавшие теги, сильнейшие первыми', () => {
  const result = score(
    candidate({ tags: ['raw punk', 'crust', 'discharge worship'] }),
    bucket,
    seedTags,
    noHardReject,
    {},
  );
  // discharge worship (1) тяжелее опорного crust (0.5), который в новой форме профиля
  // больше не гарантированно самый тяжёлый совпавший тег.
  assert.deepEqual(result.reasons.slice(0, 2), ['discharge worship', 'crust']);
});

// ---------------------------------------------------------------------------
// Defect 2: кандидат обязан нести хотя бы один опорный тег бакета
// ---------------------------------------------------------------------------

test('релиз без единого опорного тега бакета отбраковывается, даже набрав сумму весов выше порога', () => {
  // 'discharge worship' (1) + 'raw punk' (0.4) — сумма 1.4, выше MATCH_FLOOR
  // (0.5) и даже выше старого "потолка парного совпадения" (было бы 1.5,
  // здесь 1.4), но ни один из двух тегов не опорный тег бакета ('crust') —
  // до фикса такой релиз проходил бы чисто по сумме.
  const result = score(
    candidate({ tags: ['discharge worship', 'raw punk'] }),
    bucket,
    seedTags,
    noHardReject,
    {},
  );
  assert.equal(result.rejected, true);
  assert.equal(result.total, 0);
});

test('живой сценарий бага: geo-тег + общее слово набирают сумму выше пола без единого жанрового тега', () => {
  // Тот же класс кандидата, который живой прогон (2026-08) реально пропускал
  // у hardcore-punk: 'cleveland' (город) + 'diy' (общее слово) — оба
  // не-опорные, оба несут вес в этой фикстуре (моделируем через bucketAlt).
  const bucketAlt: BucketProfile = {
    tags: { crust: 0.5, cleveland: 0.4, diy: 0.35 },
    stopTags: [],
    releaseCount: 10,
    weightSum: 10,
  };
  const result = score(candidate({ tags: ['cleveland', 'diy'] }), bucketAlt, seedTags, noHardReject, {});
  assert.equal(result.rejected, true);
});

test('опорный тег плюс сколько угодно производных — по-прежнему проходит (не регрессия)', () => {
  const result = score(
    candidate({ tags: ['crust', 'discharge worship', 'raw punk'] }),
    bucket,
    seedTags,
    noHardReject,
    {},
  );
  assert.equal(result.rejected, false);
});

test('несколько опорных тегов бакета матчатся независимо (несколько seed-тегов в seedTags)', () => {
  const multiSeed = ['crust', 'crust punk', 'd-beat'];
  const withOneSeed = score(candidate({ tags: ['crust'] }), bucket, multiSeed, noHardReject, {});
  const withoutSeed = score(candidate({ tags: ['discharge worship'] }), bucket, multiSeed, noHardReject, {});
  assert.equal(withOneSeed.rejected, false);
  assert.equal(withoutSeed.rejected, true);
});

// ---------------------------------------------------------------------------
// Hard-reject: тег, который отбраковывает кандидата целиком, независимо от
// силы совпадения (задача — владелец не хочет компиляций ни под каким видом,
// см. отчёт по задаче: стоп-тег на 'compilation' не работал именно потому,
// что при сильном совпадении лишь штрафует, а не отбраковывает).
// ---------------------------------------------------------------------------

test('hard-reject тег убивает кандидата даже при совпадении намного сильнее STRONG_MATCH', () => {
  // crust + discharge worship + raw punk = 0.5 + 1 + 0.4 = 1.9, заметно выше
  // STRONG_MATCH (1.5) — именно тот уровень совпадения, который стоп-тег
  // пережил бы (см. тест «стоп-тег при сильном совпадении только
  // штрафует» выше). Hard-reject обязан убить его независимо от этого.
  const withoutHardTag = score(
    candidate({ tags: ['crust', 'discharge worship', 'raw punk'] }),
    bucket,
    seedTags,
    noHardReject,
    {},
  );
  assert.equal(withoutHardTag.rejected, false, 'контроль: без hard-reject тега кандидат проходит');

  const result = score(
    candidate({ tags: ['crust', 'discharge worship', 'raw punk', 'compilation'] }),
    bucket,
    seedTags,
    ['compilation'],
    {},
  );
  assert.equal(result.rejected, true);
  assert.equal(result.hardRejected, true);
  assert.equal(result.total, 0);
  assert.deepEqual(result.reasons, []);
});

test('hardRejected остаётся false во всех остальных путях отбраковки — не спутать с "не дотянул"', () => {
  // Слабое совпадение (MATCH_FLOOR).
  const weakMatch = score(candidate({ tags: ['ambient'] }), bucket, seedTags, ['compilation'], {});
  assert.equal(weakMatch.rejected, true);
  assert.equal(weakMatch.hardRejected, false);

  // Обычный стоп-тег (не hard-reject) при слабом совпадении.
  const stopTagWeak = score(
    candidate({ tags: ['crust', 'raw punk', 'deathcore'] }),
    bucket,
    seedTags,
    ['compilation'],
    {},
  );
  assert.equal(stopTagWeak.rejected, true);
  assert.equal(stopTagWeak.hardRejected, false);

  // Отбраковка штрафами за отскипы.
  const feedbackRejected = score(candidate({ tags: ['crust'] }), bucket, seedTags, ['compilation'], {
    tagPenalties: { crust: 10 },
  });
  assert.equal(feedbackRejected.rejected, true);
  assert.equal(feedbackRejected.hardRejected, false);

  // Успешный проход — hardRejected тоже false, не только rejected.
  const passed = score(candidate({ tags: ['crust', 'discharge worship'] }), bucket, seedTags, ['compilation'], {});
  assert.equal(passed.rejected, false);
  assert.equal(passed.hardRejected, false);
});

test('hard-reject сравнивается по каноническому тегу — регистр, пробел и дефис не создают дыру', () => {
  // Профиль хранит 'label sampler' (пробел), Bandcamp мог тегировать релиз
  // через дефис или слитно, и в другом регистре — не должно иметь значения,
  // см. canonicalizeTag в ../lib/tags.ts.
  const withHyphen = score(
    candidate({ tags: ['crust', 'Label-Sampler'] }),
    bucket,
    seedTags,
    ['label sampler'],
    {},
  );
  assert.equal(withHyphen.rejected, true);
  assert.equal(withHyphen.hardRejected, true);
});

test('пустой hardRejectTags не отбраковывает ничего (обычный проход не регрессирует)', () => {
  const result = score(
    candidate({ tags: ['crust', 'discharge worship'] }),
    bucket,
    seedTags,
    [],
    {},
  );
  assert.equal(result.rejected, false);
  assert.equal(result.hardRejected, false);
});
