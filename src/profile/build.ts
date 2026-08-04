import type { BucketId } from '../bandcamp/types.ts';
import { BUCKETS, bucketsOf } from './buckets.ts';
import { canonicalizeTag, pickDisplaySpelling } from '../lib/tags.ts';

export interface ProfileInput {
  tags: string[];
  label: string | null;
  addedAt: string;
  source: 'collection' | 'wishlist';
}

export interface BucketProfile {
  /**
   * Тег → вес 0..1. У самого характерного дискриминирующего тега бакета —
   * 1. Опорный тег бакета (см. `seedTags` в `./buckets.ts`), если пережил
   * порог `minReleases`, зафиксирован на 0.5 — см. комментарий в
   * `buildProfile`. Остальные теги весят по тому, насколько они
   * перепредставлены в этом бакете относительно своей частоты по всей
   * коллекции хозяина (см. комментарий у `overRepresentation` там же) —
   * так голые 'metal'/'punk', размазанные по всей коллекции, больше не
   * всплывают к весу 1 просто за то, что несёт почти каждый релиз бакета.
   * Теги из словаря географических мест (`locationVocabulary` в
   * `BuildOptions`, см. `./locations.ts`) сюда не попадают вовсе, даже если
   * статистически перепредставлены в бакете по-настоящему — город не
   * становится жанром от того, что сцена там большая, см. комментарий у
   * `locationVocabulary`.
   */
  tags: Record<string, number>;
  /** Теги-исключатели, заполняются задачей 11 и правятся руками. */
  stopTags: string[];
  releaseCount: number;
  weightSum: number;
}

export interface Profile {
  generatedAt: string;
  buckets: Record<BucketId, BucketProfile>;
  labels: Record<string, number>;
  /**
   * Глобальный (один на весь профиль, не per-bucket) список hard-reject
   * тегов — см. одноимённый аргумент `score()` в `./score.ts` для полного
   * разбора, чем это отличается от `BucketProfile.stopTags`. В отличие от
   * `stopTags`, у этого поля нет автоматического источника: `stopTags`
   * пересчитывается `deriveStopTagsForBucket` из хаб-сэмплов Discover
   * (см. `bin/build-profile.ts`), а hardRejectTags — чисто вкусовая
   * настройка хозяина ("не показывай мне компиляции ни при каких
   * обстоятельствах"), для которой в принципе нет статистического сигнала
   * в коллекции — `buildProfile` заполняет его пустым списком, а
   * `bin/build-profile.ts` при пересборке переносит значение из уже
   * существующего файла вперёд, а не сбрасывает (см. комментарий там же).
   */
  hardRejectTags: string[];
}

export interface BuildOptions {
  now: Date;
  /** Тег учитывается, только если встретился минимум в стольких релизах бакета. */
  minReleases?: number;
  /**
   * Словарь географических тегов (см. `./locations.ts`, `buildLocationVocabulary`).
   * Не-опорный тег, ЦЕЛИКОМ совпавший с записью этого словаря, вообще не
   * попадает в веса бакета — ни с каким весом, включая 0. Причина —
   * структурная, не статистическая: живой прогон (2026-08) показал 'new
   * york' весом 1 в hardcore-punk, притом что over-representation (см. ниже)
   * тут бессилен в принципе — сцена NYHC в коллекции хозяина статистически
   * РЕАЛЬНО перепредставлена, так что тег честно проходит и over-representation,
   * и normalize() к максимуму шкалы. Различить «характерно для жанра» и
   * «характерно для геосостава коллекции» по одним частотам нельзя — это и
   * есть отличие структурного решения от статистического. Опционален и по
   * умолчанию пуст: вызывающий код (bin/build-profile.ts) харвестит его из
   * hub-сэмплов антипрофиля тем же прогоном, но чистая buildProfile не
   * обязана знать, откуда он взялся.
   */
  locationVocabulary?: ReadonlySet<string>;
}

/**
 * Вишлист — это «хочу сейчас», но абсолютные диапазоны не должны сталкиваться
 * лбами: вишлист-позиций (497) почти вдвое больше, чем покупок (223), и если
 * множитель источника задрать, он ещё и складывается с этим численным
 * перевесом, забивая коллекцию почти полностью. Множитель держим маленьким
 * (1.2), так что диапазоны покупок [1, 1.5] и вишлиста [1.2, 1.8]
 * перекрываются: свежая покупка обгоняет старое желание, а свежее желание —
 * старую покупку. Решающая ось — свежесть, а не источник сам по себе.
 * Покупки/желания за последний год важнее давних: вкус едет со временем.
 */
function weightOf(item: ProfileInput, now: Date): number {
  const ageDays = (now.getTime() - new Date(item.addedAt).getTime()) / 86_400_000;
  const recency = ageDays <= 365 ? 1.5 : ageDays <= 1095 ? 1.2 : 1;
  return item.source === 'wishlist' ? recency * 1.2 : recency;
}

function normalize(counts: Map<string, number>): Record<string, number> {
  const max = Math.max(0, ...counts.values());
  if (max === 0) return {};
  const result: Record<string, number> = {};
  for (const [key, value] of counts) result[key] = Number((value / max).toFixed(4));
  return result;
}

/**
 * Канонический тег (см. `canonicalizeTag` в `../lib/tags.ts`) → суммарный
 * вес, число релизов бакета, где тег встретился, и — отдельно — счётчик
 * СЫРЫХ написаний, которые под этот канонический ключ схлопнулись
 * ('crust punk' 5 раз, 'crustpunk' 3, 'crust-punk' 2 — всё под одним ключом
 * 'crustpunk'). Счётчик написаний нужен только для того, чтобы в конце
 * выбрать одно человекочитаемое написание на показ — см. `pickDisplaySpelling`
 * и его использование ниже.
 */
interface TagStat {
  weight: number;
  releases: number;
  spellings: Map<string, number>;
}

/** Всё, что накапливается для одного бакета, в одной структуре. */
interface BucketAccumulator {
  tags: Map<string, TagStat>;
  releaseCount: number;
  weightSum: number;
}

export function buildProfile(items: ProfileInput[], options: BuildOptions): Profile {
  const minReleases = options.minReleases ?? 2;

  const accumulators = new Map<BucketId, BucketAccumulator>();
  for (const bucket of BUCKETS) {
    accumulators.set(bucket.id, { tags: new Map(), releaseCount: 0, weightSum: 0 });
  }

  // Лейблы считаем по всей коллекции сразу, не по бакетам, и это осознанный
  // выбор, а не недосмотр: в этой сцене лейблы честно перекрывают
  // crust/hardcore/death metal/black metal, самиздат вообще не даёт лейбла,
  // а дробление и без того разреженных данных по бакетам оставило бы в
  // каждом слишком мало, чтобы вес значил хоть что-то.
  const labels = new Map<string, number>();

  // Частота тега по ВСЕЙ коллекции (числитель — число релизов с этим
  // тегом, знаменатель — items.length), а не только по релизам бакетов.
  // Нужна как база сравнения для overRepresentation ниже: город или
  // 'metal' размазаны по всей коллекции целиком, включая релизы вне любого
  // бакета (эмбиент с тегом города и т.п.) — если считать базовую частоту
  // только по бакетированным релизам, часть их вездесущности потеряется.
  // Ключ — КАНОНИЧЕСКИЙ (см. `canonicalizeTag`), не сырое написание: без
  // этого 'crust punk' и 'crustpunk' на одном и том же релизе считались бы
  // двумя разными тегами, и их совместная вездесущность недосчитывалась бы.
  // Дисплей-написание тут не нужно — этот счётчик участвует только в
  // числовом overRepresentation ниже, а не в итоговом выводе.
  const globalTagReleases = new Map<string, number>();

  for (const item of items) {
    const weight = weightOf(item, options.now);
    if (item.label) {
      const key = item.label.trim().toLowerCase();
      labels.set(key, (labels.get(key) ?? 0) + weight);
    }

    // Теги релиза, схлопнутые по каноническому ключу: канонический ключ →
    // ПЕРВОЕ встреченное сырое написание. Дедуп нужен на случай (пусть и
    // маловероятный на практике), что Bandcamp отдал на одной странице сразу
    // два написания одного тега — для статистики релиза это всё ещё одно
    // вхождение, а не два.
    const canonicalTagsOfItem = new Map<string, string>();
    for (const raw of item.tags) {
      const spelling = raw.trim().toLowerCase();
      if (!spelling) continue;
      const key = canonicalizeTag(spelling);
      if (!canonicalTagsOfItem.has(key)) canonicalTagsOfItem.set(key, spelling);
    }

    for (const key of canonicalTagsOfItem.keys()) {
      globalTagReleases.set(key, (globalTagReleases.get(key) ?? 0) + 1);
    }
    // Релиз может задевать сразу несколько бакетов (кроссовер crust/hardcore
    // и т.п.) — он честно питает статистику каждого совпавшего, а не только
    // первого по порядку BUCKETS.
    for (const bucketId of bucketsOf(item.tags)) {
      const bucket = accumulators.get(bucketId)!;
      bucket.releaseCount += 1;
      bucket.weightSum += weight;
      for (const [key, spelling] of canonicalTagsOfItem) {
        const stat = bucket.tags.get(key) ?? { weight: 0, releases: 0, spellings: new Map() };
        stat.weight += weight;
        stat.releases += 1;
        stat.spellings.set(spelling, (stat.spellings.get(spelling) ?? 0) + 1);
        bucket.tags.set(key, stat);
      }
    }
  }
  const totalReleases = items.length;

  // Словарь мест (`../locations.ts`) хранит человекочитаемые сегменты
  // ('new york', 'richmond') — тем же способом, что и seed-теги и профиль,
  // сравнение с тегом релиза идёт по каноническому ключу, а не по точной
  // строке: тег 'new-york' или 'newyork' обязан так же попасть под словарь
  // мест, как и буквальное 'new york'. Само содержимое словаря на диске
  // (`data/location-vocabulary.json`) при этом остаётся нечитанным этой
  // канонизацией — она применяется только здесь, в момент сравнения.
  const canonicalLocationVocabulary = options.locationVocabulary
    ? new Set([...options.locationVocabulary].map(canonicalizeTag))
    : undefined;

  const buckets = {} as Record<BucketId, BucketProfile>;
  for (const bucket of BUCKETS) {
    const acc = accumulators.get(bucket.id)!;
    const seedTags = new Set(bucket.seedTags.map(canonicalizeTag));

    // Опорный тег бакета есть у каждого релиза бакета по построению (это и
    // есть критерий bucketsOf) — он всегда оказался бы максимумом и съедал
    // бы всю шкалу 0..1, вжимая по-настоящему характерные теги в ноль.
    // Поэтому нормализуем к максимуму только НЕ-опорные теги, а опорный,
    // если пережил порог minReleases, получает фиксированный вес 0.5:
    // релиз с одним лишь общим тегом всё ещё проходит порог совпадения у
    // скорера и попадает в рассмотрение, но не может перевесить релиз,
    // совпавший со специфическим вкусом хозяина.
    //
    // НЕ-опорные теги нормализуются не по сырому весу, а по
    // over-representation: живой прогон (2026-08), уже после того как
    // прошлая версия зафиксировала 'metal'/'punk' на 0.5 по доле в
    // бакете, всё равно вывела в топ шкалы города ('new york' 1, 'london'
    // 0.82 в hardcore-punk; 'seattle', 'denver', 'omaha' чуть ниже
    // seed-тегов). Доля релизов бакета сама по себе не отличает
    // характерное от вездесущего: город или голый жанр-омоним несёт
    // большую долю РАВНОМЕРНО по всей коллекции, а не именно этого
    // бакета. Мера — во сколько раз доля тега среди релизов бакета выше
    // его доли среди релизов всей коллекции хозяина (bucketRate /
    // globalRate, см. overRepresentation ниже).
    //
    // Взять это отношение напрямую как счёт (score = weight × ratio)
    // недостаточно: тег, у которого ratio ровно 1 (город одинаково
    // вездесущ и в бакете, и в среднем по коллекции — как раз случай
    // 'new york'), даёт НУЛЕВОЙ сигнал о принадлежности бакету, но при
    // прямом умножении весит тем больше, чем чаще встречается — то есть
    // именно вездесущность (а не характерность) снова тянула бы его
    // наверх шкалы, просто через другую формулу. Правильная мера
    // "насколько это информативно" — log(ratio): она равна ровно нулю
    // при ratio = 1 (тег с одинаковой частотой внутри и снаружи бакета не
    // несёт вообще никакого сигнала, сколько бы раз он ни встретился —
    // сама PMI, pointwise mutual information, устроена так же) и растёт
    // при ratio > 1 (тег гуще в этом бакете, чем в среднем). Отрицательный
    // log (ratio < 1, тег РЕЖЕ встречается в бакете, чем в среднем)
    // подрезаем нулём — это тоже "нет сигнала в пользу бакета", а не
    // повод уходить в минус.
    //
    // Два подводных камня, о которых просили позаботиться отдельно:
    // 1) Тег на 2 релизах бакета может дать огромный ratio просто от шума
    //    маленькой выборки (2 из бакета против 2 на всю коллекцию —
    //    отношение уже большое, а свидетельства почти нет). log сам по
    //    себе уже сглаживает выброс (log(200) ≈ 5.3, а не 200), но
    //    итоговый счёт всё равно домножается на stat.weight: тег с тем же
    //    ratio, но втрое большим числом релизов (весом), втрое
    //    перевешивает — количество свидетельств учитывается прямо, а не
    //    только направление скоса. minReleases (порог 2 по умолчанию)
    //    остаётся жёстким полом снизу.
    // 2) Тег, который вообще не встречается больше нигде в коллекции,
    //    кроме как в релизах этого бакета, — частный, но не патологический
    //    случай: релизы бакета — подмножество всей коллекции, поэтому его
    //    глобальный счётчик всегда включает и вхождения внутри бакета
    //    (globalCount >= stat.releases >= minReleases > 0), и globalRate
    //    никогда не бывает нулевым, когда bucketRate ненулевой — деления
    //    на ноль тут в принципе не возникает (ratio ограничен сверху
    //    totalReleases/acc.releaseCount). Проверка ниже — защита на
    //    случай, если этот инвариант когда-нибудь нарушится (например,
    //    globalTagReleases начнут копить по другому источнику): тогда тег
    //    получит нейтральный overRepresentation 1 (log = 0), а не
    //    NaN/Infinity.
    // Ключи здесь и ниже — КАНОНИЧЕСКИЕ (см. `canonicalizeTag`), не то, что
    // в итоге пишется в profile.json: несколько сырых написаний одного тега
    // ('crust punk'/'crustpunk'/'crust-punk') сходятся здесь в ОДНУ запись
    // acc.tags с суммарным весом и суммарным числом релизов — иначе каждое
    // написание по отдельности заново проходило бы порог minReleases и несло
    // свою собственную урезанную долю веса, как было до канонизации (см.
    // отчёт по этой задаче: 'dbeat'/'d-beat'/'crust punk'/'crustpunk'/
    // 'rawpunk'/'raw punk' — пять записей на три жанра в реальном прогоне).
    // Человекочитаемое написание для вывода выбирается отдельно, через
    // `pickDisplaySpelling(stat.spellings)`, только в конце — см. ниже.
    const nonSeedScores = new Map<string, number>();
    const keptSeedKeys: string[] = [];
    for (const [key, stat] of acc.tags) {
      if (stat.releases < minReleases) continue;
      if (seedTags.has(key)) {
        keptSeedKeys.push(key);
        continue;
      }
      // Проверка ПОСЛЕ seedTags и ДО over-representation: опорный тег бакета
      // побеждает словарь мест, даже если бы туда каким-то образом попал
      // (на практике не попадает — ни один seed-тег не место, см. buckets.ts),
      // а географический тег вообще не доходит до статистики
      // over-representation ниже — не получает НИКАКОГО веса, а не 0,
      // который normalize() всё равно мог бы прижать к чему-то ненулевому
      // на малой выборке.
      if (canonicalLocationVocabulary?.has(key)) continue;
      const bucketRate = acc.releaseCount > 0 ? stat.releases / acc.releaseCount : 0;
      const globalCount = globalTagReleases.get(key) ?? stat.releases;
      const globalRate = totalReleases > 0 ? globalCount / totalReleases : 0;
      const overRepresentation = globalRate > 0 ? bucketRate / globalRate : 1;
      const informativeness = Math.max(0, Math.log(overRepresentation));
      nonSeedScores.set(key, stat.weight * informativeness);
    }
    const normalizedByKey = normalize(nonSeedScores);

    // Финальный вывод: канонический ключ → человекочитаемое написание,
    // выбранное как самое частое среди фактически встреченных на релизах
    // бакета (см. `pickDisplaySpelling`) — это то, что владелец увидит и
    // сможет поправить руками в data/profile.json, и то, что попадёт в
    // reasons карточки в Telegram через совпадение в score.ts.
    const tags: Record<string, number> = {};
    for (const [key, weight] of Object.entries(normalizedByKey)) {
      tags[pickDisplaySpelling(acc.tags.get(key)!.spellings)] = weight;
    }
    for (const key of keptSeedKeys) {
      tags[pickDisplaySpelling(acc.tags.get(key)!.spellings)] = 0.5;
    }

    buckets[bucket.id] = {
      tags,
      stopTags: [],
      releaseCount: acc.releaseCount,
      weightSum: Number(acc.weightSum.toFixed(3)),
    };
  }

  return {
    generatedAt: options.now.toISOString().slice(0, 10),
    buckets,
    labels: normalize(labels),
    // См. комментарий на `Profile.hardRejectTags`: у этого поля нет
    // статистического источника в данных, buildProfile честно отдаёт
    // пустой список — заполняет и сохраняет его руками хозяин (и переносит
    // между пересборками bin/build-profile.ts).
    hardRejectTags: [],
  };
}
