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
  seedTags: readonly string[];
}

export const BUCKETS: readonly BucketDef[] = Object.freeze([
  Object.freeze({
    id: 'crust' as const,
    channelTitle: 'CRUST DAILY',
    channelEnv: 'CRUST_CHANNEL_ID',
    seedTags: Object.freeze([
      'crust',
      'crust punk',
      'crustpunk',
      'd-beat',
      'dbeat',
      'stenchcore',
      'neocrust',
    ]),
  }),
  Object.freeze({
    id: 'death-metal' as const,
    channelTitle: 'DEATH METAL DAILY',
    channelEnv: 'DEATH_METAL_CHANNEL_ID',
    seedTags: Object.freeze([
      'death metal',
      'osdm',
      'old school death metal',
      'death-doom',
      'death doom',
      'brutal death metal',
    ]),
  }),
  Object.freeze({
    id: 'hardcore-punk' as const,
    channelTitle: 'HARDCORE PUNK DAILY',
    channelEnv: 'HARDCORE_PUNK_CHANNEL_ID',
    // Голые 'hardcore' и 'punk' раньше были намеренно исключены как
    // теги-омонимы (electronic/uptempo hardcore, pop punk, skate punk и
    // т.п.) — в абстракте это верно, но живой прогон на коллекции хозяина
    // (2026-08) показал цену: из 397 релизов, не попавших ни в один
    // бакет, 280 несли 'punk' и 107 — 'hardcore' и больше ничего
    // специфичного, то есть отсекались подчистую. Хозяин решил вернуть оба
    // тега: для этой конкретной коллекции они разметочный, а не
    // омонимный сигнал. Оба голых тега лежат в общем seed-веса-0.5
    // механизме buildProfile — переубеждать скорера они как максимум
    // наравне с остальными опорными тегами, не выше.
    // Список намеренно короткий: 'youth crew' и 'straight edge' сюда не
    // входят — это сужение до одной американской линии хардкора, а
    // 'straight edge' вдобавок теговый омоним (пересекается с metalcore).
    // Не дополнять "для ровного счёта" — недостающее вытянут derived-веса
    // из данных, а хозяин всё равно проверяет профиль руками.
    seedTags: Object.freeze([
      'hardcore punk',
      'hardcore-punk',
      'powerviolence',
      'raw punk',
      'ukhc',
      'punk',
      'hardcore',
    ]),
  }),
  Object.freeze({
    id: 'black-metal' as const,
    channelTitle: 'BLACK METAL DAILY',
    channelEnv: 'BLACK_METAL_CHANNEL_ID',
    // 'black metal' и 'raw black metal' — впрямую подтверждены тем же
    // живым прогоном: среди 397 небакетированных релизов это 52 и 10
    // штук соответственно, четвёртый и седьмой по частоте теги во всей
    // не-бакетированной массе. Остальные два — 'atmospheric black metal'
    // и 'blackgaze' — не подтверждены той же выгрузкой (в ней не было
    // разбивки глубже топ-8), но добавлены консервативно: это
    // однозначные составные жанровые теги без омонимии на Bandcamp,
    // в отличие от голого 'black' или модификатора 'blackened'
    // (blackened death/crust — не то же самое, что чёрный метал сам по
    // себе). Узкие поджанры (nsbm, war metal, pagan black metal и т.п.)
    // намеренно не добавлены — коллекция их наличие не подтверждает.
    seedTags: Object.freeze(['black metal', 'raw black metal', 'atmospheric black metal', 'blackgaze']),
  }),
]);

/**
 * Все бакеты, чьи seed-теги пересекаются с тегами релиза, в порядке BUCKETS.
 * Это не классификация "релиз принадлежит одному бакету" — релиз может
 * питать статистику нескольких бакетов сразу (кроссовер crust/hardcore —
 * обычное дело в этой коллекции). Пустой массив, если совпадений нет.
 */
export function bucketsOf(tags: string[]): BucketId[] {
  const normalized = new Set(tags.map((tag) => tag.toLowerCase()));
  const result: BucketId[] = [];
  for (const bucket of BUCKETS) {
    const hasHit = bucket.seedTags.some((tag) => normalized.has(tag.toLowerCase()));
    if (hasHit) result.push(bucket.id);
  }
  return result;
}
