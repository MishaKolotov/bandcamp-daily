import type { BucketId } from '../bandcamp/types.ts';
import { canonicalizeTag } from '../lib/tags.ts';

export interface BucketDef {
  id: BucketId;
  /** Человекочитаемое имя жанра — уходит в текст карточки владельца. */
  title: string;
  /**
   * Опорные теги: по ним релиз из коллекции относится к бакету.
   * Остальные веса тегов вычисляются из данных, эти заданы вручную.
   */
  seedTags: readonly string[];
}

export const BUCKETS: readonly BucketDef[] = Object.freeze([
  Object.freeze({
    id: 'crust' as const,
    title: 'краст',
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
    title: 'дэт-метал',
    // 'brutal death metal' убран из опорных по данным живого прогона: в
    // коллекции владельца таких релизов ноль, зато в хабе дэт-метала тег
    // встречается на 27 релизах из 60. Как опорный он объявлял бы жанром
    // канала то, чего владелец не слушает, и заодно блокировал сам себя от
    // попадания в стоп-лист — семейство брутал/слэм именно поэтому и должно
    // отсекаться антипрофилем, а не притягиваться.
    // 'death-doom' убран той же проверкой, но по другой причине: это не
    // ложный сигнал (как 'brutal death metal'), а фантомный тег — в реальном
    // data/profile.json (2026-08) его нет вовсе, ни под одним написанием,
    // ни с каким весом. У owner'а просто нет ни одного релиза с этим тегом
    // (или он есть в количестве меньше minReleases), так что тег не пережил
    // порог в buildProfile и никогда не попадёт в bucketProfile.tags.
    // Опорный тег в этом состоянии — не нейтральная деталь: релиз, несущий
    // ТОЛЬКО его, матчится с весом 0 (в bucket.tags такого ключа нет) и
    // получает total 0 — отбраковывается, хотя MATCH_FLOOR в score.ts
    // прямым текстом рассчитан на то, что «релиз с одним лишь опорным тегом
    // проходит порог». Тот же класс проблемы, тот же диагноз, что и у
    // 'brutal death metal' — см. отчёт по задаче.
    seedTags: Object.freeze(['death metal', 'osdm', 'old school death metal']),
  }),
  Object.freeze({
    id: 'hardcore-punk' as const,
    title: 'хардкор-панк',
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
    id: 'electronic' as const,
    title: 'электроника',
    // Единственный бакет, вкус для которого взят НЕ из покупок на Bandcamp:
    // электроники в коллекции владельца нет ни одного релиза, зато в
    // сохранённом Spotify её половина слушаемого (113 артистов с тегом
    // 'electronic' против 85 с 'punk' — см. data/spotify-crosswalk.json).
    // Профиль для него собирается из тех же артистов, разрешённых на Bandcamp
    // (см. bin/build-profile.ts).
    //
    // Голых 'electronic', 'house' и 'ambient' в опорных нет намеренно. Это
    // зонтики на сотни тысяч релизов — та же ловушка, что с 'punk' и 'metal'
    // (см. orderSeedTagsBySpecificity ниже): по ним хаб дня забьётся чем
    // угодно. Составные и узкие теги идут первыми и решают, бакет ли это,
    // голые 'techno'/'trance' остаются как широкая подстраховка.
    seedTags: Object.freeze([
      'acid techno',
      'hard techno',
      'hard trance',
      'acid trance',
      'goa trance',
      'psytrance',
      'industrial techno',
      'breakcore',
      'hardtekno',
      'gabber',
      'jungle',
      'techno',
      'trance',
      'rave',
    ]),
  }),
  Object.freeze({
    id: 'black-metal' as const,
    title: 'блэк-метал',
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
 * Упорядочивает seed-теги бакета так, что составные (специфичные) идут
 * первыми, а голые однословные — только последними, в исходном порядке.
 *
 * Голые однословные теги вроде 'punk', 'hardcore' — Bandcamp-омонимы с
 * хабом на сотни тысяч релизов (живой прогон 2026-08 отдал 470000 для
 * 'punk' и 496000 для 'metal'); сэмпл или хаб-запрос по такому тегу
 * описывает Bandcamp вообще, а не соседний жанр или собственный жанр
 * бакета. Составные теги (есть пробел или дефис — 'raw punk', 'd-beat',
 * 'old school death metal') специфичны по построению: у них нет той же
 * омонимии, значит и хаб уже.
 *
 * Общий helper для двух вызывающих кодов, которым нужен один и тот же
 * порядок предпочтения: `hubSampleTags` ниже (сэмплирование тег-хаба для
 * антипрофиля/стоп-тегов, см. `bin/build-profile.ts`) и `hubTagsForBucket`
 * в `../pipeline/daily.ts` (резерв слотов под seed-теги в дневных
 * хаб-запросах Discover — тот же класс бага, что чинил `hubSampleTags`,
 * см. комментарий там же). Стабильная сортировка: порядок внутри каждой из
 * двух групп (специфичные/голые) не меняется.
 */
export function orderSeedTagsBySpecificity(seedTags: readonly string[]): string[] {
  const isSpecific = (tag: string): boolean => /[\s-]/.test(tag);
  return [...seedTags].sort((a, b) => Number(isSpecific(b)) - Number(isSpecific(a)));
}

/**
 * Seed-теги бакета, отобранные под сэмплирование тег-хаба Discover для
 * антипрофиля (стоп-тегов) — см. `deriveStopTags` в `./stop-tags.ts` и
 * вызов в `bin/build-profile.ts`. Предпочитает составные теги голым
 * однословным (см. `orderSeedTagsBySpecificity`), а голые однословные
 * берёт, только если составных не хватает до limit — недобакетированный
 * хаб лучше, чем вовсе без антипрофиля.
 */
export function hubSampleTags(bucket: BucketDef, limit: number): string[] {
  return orderSeedTagsBySpecificity(bucket.seedTags).slice(0, limit);
}
