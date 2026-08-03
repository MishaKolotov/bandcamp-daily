export interface StopTagInput {
  /** Тег → сколько раз встретился среди релизов тег-хаба. */
  hubTagCounts: Record<string, number>;
  /** Все теги, встречающиеся в коллекции и вишлисте владельца. */
  ownedTags: Set<string>;
  /**
   * Seed-теги бакета, для которого сейчас выводится стоп-лист (см.
   * buckets.ts). Обязателен: без него легко забыть передать защиту и
   * тихо вернуть self-sabotage-баг — тег своего же жанра попадёт в
   * собственный стоп-лист. Теги других бакетов сюда не относятся —
   * кроссовер-релиз (например d-beat, просочившийся в хаб death-metal),
   * которого нет в коллекции владельца, обязан суметь стать стоп-тегом
   * для этого хаба.
   */
  seedTags: readonly string[];
  minHubCount?: number;
  limit?: number;
}

/**
 * Стоп-тег = встречается в хабе часто, а у владельца не встречается ни разу.
 * Такие теги маркируют соседний жанр, который владелец не слушает.
 *
 * Seed-теги переданного бакета в стоп-лист не попадают никогда: это и есть
 * жанр канала, а не соседний — то, что владелец купил мало релизов с
 * конкретным seed-тегом, не значит, что канал должен себя же штрафовать.
 */
export function deriveStopTags(input: StopTagInput): string[] {
  const minHubCount = input.minHubCount ?? 5;
  const limit = input.limit ?? 40;
  const ownedLower = new Set([...input.ownedTags].map((tag) => tag.toLowerCase()));
  const seedLower = new Set(input.seedTags.map((tag) => tag.toLowerCase()));
  return Object.entries(input.hubTagCounts)
    .filter(([, count]) => count >= minHubCount)
    .filter(([tag]) => !ownedLower.has(tag.toLowerCase()))
    .filter(([tag]) => !seedLower.has(tag.toLowerCase()))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag]) => tag);
}
