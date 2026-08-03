import type { BucketId } from '../bandcamp/types.ts';

export interface BucketDef {
  id: BucketId;
  /** Человекочитаемое имя канала — уходит в текст поста. */
  channelTitle: string;
  /** Имя переменной окружения с chat_id канала. */
  channelEnv: string;
  /**
   * Опорные теги: по ним релиз из коллекции относится к бакету.
   * Остальные веса тегов вычисляются из данных, эти заданы вручную.
   */
  seedTags: string[];
}

export const BUCKETS: BucketDef[] = [
  {
    id: 'crust',
    channelTitle: 'CRUST DAILY',
    channelEnv: 'CRUST_CHANNEL_ID',
    seedTags: ['crust', 'crust punk', 'crustpunk', 'd-beat', 'dbeat', 'stenchcore', 'neocrust'],
  },
  {
    id: 'death-metal',
    channelTitle: 'DEATH METAL DAILY',
    channelEnv: 'DEATH_METAL_CHANNEL_ID',
    seedTags: [
      'death metal',
      'osdm',
      'old school death metal',
      'death-doom',
      'death doom',
      'brutal death metal',
    ],
  },
  {
    id: 'hardcore-punk',
    channelTitle: 'HARDCORE PUNK DAILY',
    channelEnv: 'HARDCORE_PUNK_CHANNEL_ID',
    // Голые 'hardcore' и 'punk' намеренно не включены: на Bandcamp это
    // теги-омонимы (electronic/uptempo hardcore, pop punk, skate punk и
    // т.п.) — релиз с таким тегом не обязательно хардкор-панк.
    seedTags: ['hardcore punk', 'powerviolence', 'raw punk', 'ukhc', 'youth crew', 'straight edge'],
  },
];

/** Бакет релиза: тот, чьих seed-тегов совпало больше. Ничьи разрешаются порядком BUCKETS. */
export function bucketOf(tags: string[]): BucketId | null {
  const normalized = new Set(tags.map((tag) => tag.toLowerCase()));
  let best: { id: BucketId; hits: number } | null = null;
  for (const bucket of BUCKETS) {
    const hits = bucket.seedTags.filter((tag) => normalized.has(tag)).length;
    if (hits > 0 && (best === null || hits > best.hits)) best = { id: bucket.id, hits };
  }
  return best?.id ?? null;
}
