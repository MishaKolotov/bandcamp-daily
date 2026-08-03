import type { BucketId } from '../bandcamp/types.ts';
import { canonicalizeTag } from '../lib/tags.ts';

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
    // Написания-варианты ('crustpunk', 'dbeat') отсюда убраны: тег теперь
    // сравнивается по каноническому ключу (`canonicalizeTag` в
    // `../lib/tags.ts`, пробел/дефис/слитно — один и тот же тег), так что
    // держать все три написания в списке вручную избыточно и рискует
    // разъехаться, если кто-то дополнит только один вариант. Список ниже —
    // по одному человекочитаемому написанию на жанр, в общепринятой форме
    // (Wikipedia: «Crust punk», «D-beat»).
    seedTags: Object.freeze(['crust', 'crust punk', 'd-beat', 'stenchcore', 'neocrust']),
  }),
  Object.freeze({
    id: 'death-metal' as const,
    channelTitle: 'DEATH METAL DAILY',
    channelEnv: 'DEATH_METAL_CHANNEL_ID',
    // 'death-doom' и 'death doom' были двумя записями одного канонического
    // тега — см. комментарий у crust.seedTags выше про canonicalizeTag.
    // Оставлено принятое написание (Wikipedia: «Death-doom»).
    seedTags: Object.freeze([
      'death metal',
      'osdm',
      'old school death metal',
      'death-doom',
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
    //
    // 'hardcore-punk' (дефисный вариант) убран как избыточная запись того же
    // канонического тега, что и 'hardcore punk' — см. canonicalizeTag в
    // ../lib/tags.ts. Голые 'punk' и 'hardcore' НЕ схлопываются с 'hardcore
    // punk' канонизацией (разное число слов после вырезания разделителя,
    // см. тест в lib/tags.test.ts) — это то же самое разделение, которого
    // просил хозяин, и оно остаётся в силе.
    seedTags: Object.freeze(['hardcore punk', 'powerviolence', 'raw punk', 'ukhc', 'punk', 'hardcore']),
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
 *
 * Сравнение — по каноническому ключу (`canonicalizeTag`, см. `../lib/tags.ts`):
 * релиз, тегированный Bandcamp как 'crustpunk' или 'crust-punk', обязан
 * попасть в бакет так же надёжно, как и 'crust punk' — это ровно тот же тег,
 * просто иначе набранный.
 */
export function bucketsOf(tags: string[]): BucketId[] {
  const normalized = new Set(tags.map(canonicalizeTag));
  const result: BucketId[] = [];
  for (const bucket of BUCKETS) {
    const hasHit = bucket.seedTags.some((tag) => normalized.has(canonicalizeTag(tag)));
    if (hasHit) result.push(bucket.id);
  }
  return result;
}

/**
 * Seed-теги бакета, отобранные под сэмплирование тег-хаба Discover для
 * антипрофиля (стоп-тегов) — см. `deriveStopTags` в `./stop-tags.ts` и
 * вызов в `bin/build-profile.ts`.
 *
 * Голые однословные теги вроде 'punk', 'hardcore' — Bandcamp-омонимы с
 * хабом на сотни тысяч релизов (живой прогон 2026-08 отдал 470000 для
 * 'punk' и 496000 для 'metal'); сэмпл 60 релизов из такого хаба описывает
 * Bandcamp вообще, а не соседний жанр, и именно это раньше держало
 * стоп-листы всех трёх бакетов пустыми. Составные теги (есть пробел или
 * дефис — 'raw punk', 'd-beat', 'old school death metal') специфичны по
 * построению: у них нет той же омонимии, значит и хаб уже. Поэтому
 * предпочитаем составные, а голые однословные берём, только если
 * составных не хватает до limit — недобакетированный хаб лучше, чем
 * вовсе без антипрофиля.
 */
export function hubSampleTags(bucket: BucketDef, limit: number): string[] {
  const isSpecific = (tag: string): boolean => /[\s-]/.test(tag);
  // Стабильная сортировка: специфичные теги — вперёд, порядок внутри каждой
  // из двух групп не меняется. Так составные теги всегда выбираются
  // первыми, а голые однословные попадают в выборку только чтобы
  // добрать limit, если специфичных не хватило.
  const ordered = [...bucket.seedTags].sort((a, b) => Number(isSpecific(b)) - Number(isSpecific(a)));
  return ordered.slice(0, limit);
}
