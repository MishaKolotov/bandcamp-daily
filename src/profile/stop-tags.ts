import { BUCKETS } from './buckets.ts';

export interface StopTagInput {
  /** Тег → сколько раз встретился среди релизов тег-хаба. */
  hubTagCounts: Record<string, number>;
  /** Все теги, встречающиеся в коллекции и вишлисте владельца. */
  ownedTags: Set<string>;
  minHubCount?: number;
  limit?: number;
}

/** Все seed-теги всех бакетов, в нижнем регистре — их нельзя пускать в стоп-лист. */
const SEED_TAGS = new Set(
  BUCKETS.flatMap((bucket) => bucket.seedTags.map((tag) => tag.toLowerCase())),
);

/**
 * Стоп-тег = встречается в хабе часто, а у владельца не встречается ни разу.
 * Такие теги маркируют соседний жанр, который владелец не слушает.
 *
 * Seed-теги (опорные теги бакетов, см. buckets.ts) в стоп-лист не попадают
 * никогда: это и есть жанр канала, а не соседний — то, что владелец купил
 * мало релизов с конкретным seed-тегом, не значит, что канал должен себя
 * же штрафовать.
 */
export function deriveStopTags(input: StopTagInput): string[] {
  const minHubCount = input.minHubCount ?? 5;
  const limit = input.limit ?? 40;
  const ownedLower = new Set([...input.ownedTags].map((tag) => tag.toLowerCase()));
  return Object.entries(input.hubTagCounts)
    .filter(([tag, count]) => count >= minHubCount)
    .filter(([tag]) => !ownedLower.has(tag.toLowerCase()))
    .filter(([tag]) => !SEED_TAGS.has(tag.toLowerCase()))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag]) => tag);
}
