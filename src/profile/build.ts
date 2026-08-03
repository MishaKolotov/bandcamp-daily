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
   * 1. Опорный тег бакета (см. `seedTags` в `./buckets.ts`) и любой
   * зонтичный тег (несёт большая доля релизов бакета, см. `umbrellaShare`
   * в `BuildOptions`), если пережили порог `minReleases`, зафиксированы на
   * 0.5 — см. комментарий в `buildProfile`.
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
  /**
   * Доля релизов бакета, начиная с которой НЕ-опорный тег считается
   * зонтичным (см. комментарий в `buildProfile`) и фиксируется на 0.5
   * вместо участия в нормализации к максимуму 1.
   *
   * Порог 0.6 выбран по живому прогону (2026-08) на коллекции хозяина:
   * зонтичные теги 'punk' в crust и 'metal' в death-metal (ни один не
   * входит в seedTags своего бакета) несла «почти каждая» позиция бакета —
   * то есть доля, близкая к 90-100%. Настоящие дискриминирующие
   * кроссовер-теги того же прогона
   * («doom metal», «black metal» внутри death-metal) вышли с
   * нормализованным весом 0.28 и 0.24 — то есть их доля от максимума
   * заведомо меньше половины. 0.6 лежит с запасом выше «почти всех» и с
   * таким же запасом выше зоны реальных кроссоверов, так что не должен
   * задевать характерные теги, только настоящие зонтичные.
   */
  umbrellaShare?: number;
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
  const umbrellaShare = options.umbrellaShare ?? 0.6;

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

  for (const item of items) {
    const weight = weightOf(item, options.now);
    if (item.label) {
      const key = item.label.trim().toLowerCase();
      labels.set(key, (labels.get(key) ?? 0) + weight);
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
    // Та же болезнь бьёт и НЕ-опорные теги: живой прогон (2026-08) показал
    // 'metal' весом 1 в death-metal и 'punk' весом 1 в crust — теги, которых
    // ни разу не было в seedTags этих бакетов, но которые несёт почти
    // каждый релиз бакета, так что они точно так же съедали шкалу и не
    // различали ничего. Обобщаем: любой тег (опорный или нет), несущий
    // долю релизов бакета не ниже umbrellaShare, — зонтичный, и получает
    // тот же фиксированный вес 0.5, а не участвует в нормализации.
    // Нормализуется к максимуму 1 только оставшийся, по-настоящему
    // дискриминирующий остаток.
    const nonSeedWeights = new Map<string, number>();
    const keptSeedTags: string[] = [];
    const umbrellaTags: string[] = [];
    for (const [tag, stat] of acc.tags) {
      if (stat.releases < minReleases) continue;
      if (seedTags.has(tag)) {
        keptSeedTags.push(tag);
        continue;
      }
      const share = acc.releaseCount > 0 ? stat.releases / acc.releaseCount : 0;
      if (share >= umbrellaShare) {
        umbrellaTags.push(tag);
      } else {
        nonSeedWeights.set(tag, stat.weight);
      }
    }
    const tags = normalize(nonSeedWeights);
    for (const tag of keptSeedTags) tags[tag] = 0.5;
    for (const tag of umbrellaTags) tags[tag] = 0.5;

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
