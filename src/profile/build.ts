import type { BucketId } from '../bandcamp/types.ts';
import { BUCKETS, bucketsOf } from './buckets.ts';

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
   * так голые 'metal'/'punk'/города, размазанные по всей коллекции,
   * больше не всплывают к весу 1 просто за то, что несёт почти каждый
   * релиз бакета.
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
}

export interface BuildOptions {
  now: Date;
  /** Тег учитывается, только если встретился минимум в стольких релизах бакета. */
  minReleases?: number;
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

/** Тег → { суммарный вес, число релизов бакета, где тег встретился }. */
interface TagStat {
  weight: number;
  releases: number;
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
  const globalTagReleases = new Map<string, number>();

  for (const item of items) {
    const weight = weightOf(item, options.now);
    if (item.label) {
      const key = item.label.trim().toLowerCase();
      labels.set(key, (labels.get(key) ?? 0) + weight);
    }
    for (const tag of new Set(item.tags.map((t) => t.toLowerCase()))) {
      globalTagReleases.set(tag, (globalTagReleases.get(tag) ?? 0) + 1);
    }
    // Релиз может задевать сразу несколько бакетов (кроссовер crust/hardcore
    // и т.п.) — он честно питает статистику каждого совпавшего, а не только
    // первого по порядку BUCKETS.
    for (const bucketId of bucketsOf(item.tags)) {
      const bucket = accumulators.get(bucketId)!;
      bucket.releaseCount += 1;
      bucket.weightSum += weight;
      for (const tag of new Set(item.tags.map((t) => t.toLowerCase()))) {
        const stat = bucket.tags.get(tag) ?? { weight: 0, releases: 0 };
        stat.weight += weight;
        stat.releases += 1;
        bucket.tags.set(tag, stat);
      }
    }
  }
  const totalReleases = items.length;

  const buckets = {} as Record<BucketId, BucketProfile>;
  for (const bucket of BUCKETS) {
    const acc = accumulators.get(bucket.id)!;
    const seedTags = new Set(bucket.seedTags.map((t) => t.toLowerCase()));

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
    const nonSeedScores = new Map<string, number>();
    const keptSeedTags: string[] = [];
    for (const [tag, stat] of acc.tags) {
      if (stat.releases < minReleases) continue;
      if (seedTags.has(tag)) {
        keptSeedTags.push(tag);
        continue;
      }
      const bucketRate = acc.releaseCount > 0 ? stat.releases / acc.releaseCount : 0;
      const globalCount = globalTagReleases.get(tag) ?? stat.releases;
      const globalRate = totalReleases > 0 ? globalCount / totalReleases : 0;
      const overRepresentation = globalRate > 0 ? bucketRate / globalRate : 1;
      const informativeness = Math.max(0, Math.log(overRepresentation));
      nonSeedScores.set(tag, stat.weight * informativeness);
    }
    const tags = normalize(nonSeedScores);
    for (const tag of keptSeedTags) tags[tag] = 0.5;

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
  };
}
