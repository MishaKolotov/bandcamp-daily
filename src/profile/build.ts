import type { BucketId } from '../bandcamp/types.ts';
import { BUCKETS, bucketsOf } from './buckets.ts';

export interface ProfileInput {
  tags: string[];
  label: string | null;
  addedAt: string;
  source: 'collection' | 'wishlist';
}

export interface BucketProfile {
  /** Тег → вес 0..1, где 1 у самого характерного тега бакета. */
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
 * Вишлист — это «хочу сейчас», он важнее старой покупки.
 * Покупки за последний год важнее давних: вкус едет со временем.
 */
function weightOf(item: ProfileInput, now: Date): number {
  const ageDays = (now.getTime() - new Date(item.addedAt).getTime()) / 86_400_000;
  const recency = ageDays <= 365 ? 1.5 : ageDays <= 1095 ? 1.2 : 1;
  return item.source === 'wishlist' ? recency * 1.6 : recency;
}

function normalize(counts: Map<string, number>): Record<string, number> {
  const max = Math.max(0, ...counts.values());
  if (max === 0) return {};
  const result: Record<string, number> = {};
  for (const [key, value] of counts) result[key] = Number((value / max).toFixed(4));
  return result;
}

export function buildProfile(items: ProfileInput[], options: BuildOptions): Profile {
  const minReleases = options.minReleases ?? 2;

  const weighted = new Map<BucketId, Map<string, number>>();
  const documents = new Map<BucketId, Map<string, number>>();
  const stats = new Map<BucketId, { count: number; weight: number }>();
  for (const bucket of BUCKETS) {
    weighted.set(bucket.id, new Map());
    documents.set(bucket.id, new Map());
    stats.set(bucket.id, { count: 0, weight: 0 });
  }
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
      const stat = stats.get(bucketId)!;
      stat.count += 1;
      stat.weight += weight;
      const tagWeights = weighted.get(bucketId)!;
      const tagDocs = documents.get(bucketId)!;
      for (const tag of new Set(item.tags.map((t) => t.toLowerCase()))) {
        tagWeights.set(tag, (tagWeights.get(tag) ?? 0) + weight);
        tagDocs.set(tag, (tagDocs.get(tag) ?? 0) + 1);
      }
    }
  }

  const buckets = {} as Record<BucketId, BucketProfile>;
  for (const bucket of BUCKETS) {
    const tagWeights = weighted.get(bucket.id)!;
    const tagDocs = documents.get(bucket.id)!;
    const kept = new Map<string, number>();
    for (const [tag, weight] of tagWeights) {
      if ((tagDocs.get(tag) ?? 0) >= minReleases) kept.set(tag, weight);
    }
    const stat = stats.get(bucket.id)!;
    buckets[bucket.id] = {
      tags: normalize(kept),
      stopTags: [],
      releaseCount: stat.count,
      weightSum: Number(stat.weight.toFixed(3)),
    };
  }

  return {
    generatedAt: options.now.toISOString().slice(0, 10),
    buckets,
    labels: normalize(labels),
  };
}
