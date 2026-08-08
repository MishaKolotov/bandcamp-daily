import { canonicalizeTag, pickDisplaySpelling } from '../lib/tags.ts';

export interface StopTagInput {
  /** Тег → сколько раз встретился среди релизов тег-хаба. */
  hubTagCounts: Record<string, number>;
  /**
   * Тег → на скольких релизах коллекции и вишлиста владельца встретился.
   *
   * Раньше здесь было множество (`Set<string>`) — просто «есть тег хоть на
   * одном релизе». Живой прогон (2026-08, 720 релизов коллекции+вишлиста,
   * из них 91 не задевает ни один бакет) показал цену: с широкой
   * коллекцией владелец задевает почти каждый расхожий тег хотя бы раз —
   * залётный кроссовер, опечатка тегирования на Bandcamp, тег-имя лейбла
   * или артиста, вообще встретившийся один раз (в data/profile.json таких
   * полно: 'iron lung records', 'd4mtlabsinc', 'toxic state records' —
   * очевидно не жанр, а тег с единственного релиза этого лейбла). Единственное
   * вхождение — не вкус, а шум, и раньше оно иммунизировало тег навсегда:
   * стоп-листы были пустыми во всех бакетах разом. Теперь тег считается
   * «своим» только начиная с `minOwnedCount` вхождений — см. там же.
   */
  ownedTagCounts: Record<string, number>;
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
  /**
   * Сколько релизов реально сэмплировано из тег-хаба. Обязателен: сырые
   * счётчики без этого числа не поддаются интерпретации — count: 5 значит
   * разное при выборке 20 и при выборке 500, поэтому порог считается как
   * доля от этого числа (см. minHubShare), а не как голая константа.
   */
  releasesSampled: number;
  /**
   * Абсолютный пол для порога частоты в хабе. Нужен отдельно от доли:
   * при маленькой выборке доля даёт крошечное число (minHubShare * 20 = 4),
   * и без пола тег с счётчиком 2 мог бы проскочить. Порог = максимум из
   * этого пола и доли выборки.
   */
  minHubCount?: number;
  /**
   * Доля выборки, начиная с которой тег хаба считается достаточно частым,
   * чтобы маркировать соседний жанр, а не быть шумом или орфографическим
   * вариантом. Профильный скрипт сэмплирует по бакету примерно 60–180
   * релизов; доля 0.2 при такой выборке — это порядка 12–36 совпадений.
   */
  minHubShare?: number;
  /**
   * Сколько раз тег должен встретиться в коллекции/вишлисте владельца
   * (`ownedTagCounts`), чтобы считаться «своим», а не шумом одного
   * случайного релиза.
   *
   * 2 — та же граница «шум vs сигнал», что `minReleases` в `buildProfile`
   * (build.ts, порог по умолчанию тоже 2): один релиз статистически ничего
   * не доказывает, а нижняя граница задаётся ЭТОЙ функцией, а не подгоняется
   * снизу до первого непустого результата — понижать её дальше ради того,
   * чтобы стоп-лист вообще не пустовал, значит начать штрафовать жанр,
   * которого владелец коснулся один раз случайно, но который ему может
   * искренне нравиться (а вот два самостоятельных приобретения — уже вряд
   * ли случайность).
   */
  minOwnedCount?: number;
  /**
   * Словарь географических тегов (см. `buildLocationVocabulary` в
   * `./locations.ts`) — тот же словарь, который `buildProfile` (`./build.ts`)
   * уже использует, чтобы не давать тегам мест веса в бакете. Тег, ЦЕЛИКОМ
   * совпавший с записью словаря по каноническому ключу, в стоп-лист не
   * попадает никогда, даже если хаб-частый и невладеемый — живой прогон
   * (2026-08) отдал 'amadora' (город в Португалии) хаб-частым (12 из 60) и
   * невладеемым ровно так же, как настоящий соседний поджанр, а стоп-тег из
   * имени места штрафовал бы каждый релиз из этого города вообще без
   * отношения к жанру, см. отчёт по задаче.
   *
   * Опционален и по умолчанию не фильтрует ничего — старое поведение (без
   * гео-фильтрации) сохраняется без изменений, если вызывающий код его не
   * передаёт.
   */
  locationVocabulary?: ReadonlySet<string>;
  limit?: number;
}

/**
 * Стоп-тег = встречается в хабе часто (относительно размера выборки), а у
 * владельца нет реальных свидетельств владения (см. `minOwnedCount`). Такие
 * теги маркируют соседний жанр, который владелец не слушает.
 *
 * Seed-теги переданного бакета в стоп-лист не попадают никогда: это и есть
 * жанр самого бакета, а не соседний — то, что владелец купил мало релизов
 * с конкретным seed-тегом, не значит, что бакет должен себя же штрафовать.
 *
 * Географические теги (город, страна) на Bandcamp не самофильтруются, как
 * это делают жанровые зонтичные теги — то, что владелец ничего не купил из
 * какой-то конкретной страны, не значит, что он не стал бы слушать оттуда
 * death metal, это просто пробел в коллекции, а не вкусовой антипрофиль.
 * Эта функция сама не отличает географию от жанра по форме слова (и не
 * должна — 'richmond' и 'reading' неотличимы как строки), но принимает
 * готовый словарь мест через `locationVocabulary` и вычитает его целиком —
 * см. комментарий там же. Без переданного словаря защиты нет: сгенерированный
 * стоп-лист в этом случае всё ещё нужно вручную просматривать на предмет
 * городов и стран, прежде чем доверять профилю.
 *
 * Все три входа (хаб, владение, seed-теги) сравниваются по КАНОНИЧЕСКОМУ
 * ключу тега (см. `canonicalizeTag` в `../lib/tags.ts`), не по точной
 * строке: без этого одно и то же соседнее написание жанра ('crust punk',
 * 'crustpunk', 'crust-punk') оседало бы в `hubTagCounts` тремя отдельными
 * записями, каждая из которых по отдельности могла не дотянуть до порога
 * частоты — и стоп-тег молча пропадал бы целиком вместо того, чтобы
 * пройти по суммарному счёту (тот же класс дилюции, что чинит `build.ts`
 * для весов профиля — см. отчёт по задаче).
 */
export function deriveStopTags(input: StopTagInput): string[] {
  const minHubCount = input.minHubCount ?? 5;
  const minHubShare = input.minHubShare ?? 0.2;
  const minOwnedCount = input.minOwnedCount ?? 2;
  const limit = input.limit ?? 40;
  const threshold = Math.max(minHubCount, minHubShare * input.releasesSampled);

  const ownedCounts = new Map<string, number>();
  for (const [tag, count] of Object.entries(input.ownedTagCounts)) {
    const key = canonicalizeTag(tag);
    ownedCounts.set(key, (ownedCounts.get(key) ?? 0) + count);
  }
  const seedCanonical = new Set(input.seedTags.map(canonicalizeTag));
  const locationCanonical = input.locationVocabulary
    ? new Set([...input.locationVocabulary].map(canonicalizeTag))
    : undefined;

  /** Канонический тег хаба → суммарный счёт + написание → его собственный счёт (для display). */
  interface HubGroup {
    count: number;
    spellings: Map<string, number>;
  }
  const hubGroups = new Map<string, HubGroup>();
  for (const [tag, count] of Object.entries(input.hubTagCounts)) {
    const key = canonicalizeTag(tag);
    const group = hubGroups.get(key) ?? { count: 0, spellings: new Map() };
    group.count += count;
    // Record<string, number> не может содержать один и тот же сырой ключ
    // дважды, так что здесь всегда одна запись на написание — просто её
    // собственный счёт из hubTagCounts, без накопления.
    group.spellings.set(tag, count);
    hubGroups.set(key, group);
  }

  return [...hubGroups.entries()]
    .filter(([, group]) => group.count >= threshold)
    .filter(([key]) => (ownedCounts.get(key) ?? 0) < minOwnedCount)
    .filter(([key]) => !seedCanonical.has(key))
    .filter(([key]) => !locationCanonical?.has(key))
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, limit)
    .map(([, group]) => pickDisplaySpelling(group.spellings));
}

export interface HubStopTagSample {
  /** Тег → сколько раз встретился среди релизов ОДНОГО тег-хаба (не пула по бакету). */
  hubTagCounts: Record<string, number>;
  /** Сколько релизов реально сэмплировано из ЭТОГО ОДНОГО хаба. */
  releasesSampled: number;
}

export interface BucketStopTagInput {
  /**
   * По одному сэмплу на каждый хаб-тег бакета (см. `hubSampleTags` в
   * `./buckets.ts`). Хабы оцениваются НЕЗАВИСИМО друг от друга — каждый
   * против СВОЕГО порога (своей `releasesSampled`), а не против суммы всех
   * хабов бакета — см. комментарий у `deriveStopTagsForBucket` ниже, почему
   * это принципиально.
   */
  hubs: readonly HubStopTagSample[];
  ownedTagCounts: Record<string, number>;
  seedTags: readonly string[];
  locationVocabulary?: ReadonlySet<string>;
  minHubCount?: number;
  minHubShare?: number;
  minOwnedCount?: number;
  /** Общий потолок на итоговый (объединённый) список бакета — не на хаб. */
  limit?: number;
}

/**
 * Стоп-теги бакета = объединение стоп-тегов каждого его хаб-тега, посчитанных
 * ПО ОТДЕЛЬНОСТИ.
 *
 * До этой задачи `bin/build-profile.ts` сэмплировал 3 хаб-тега бакета по 60
 * релизов каждый, СКЛАДЫВАЛ все 180 счётчиков в один `hubTagCounts` и звал
 * `deriveStopTags` один раз на весь пул с `releasesSampled: 180`. Порог 0.2
 * от 180 — это 36 совпадений. Тег, характерный для ОДНОГО из трёх хабов
 * (например, 'brutal death metal', концентрирующийся вокруг хаб-тега 'death
 * metal', но почти не встречающийся в хабах 'old school death metal' и
 * 'death-doom'), физически не может набрать больше своего потолка в 60 —
 * 0.33 доли пула максимум, а на практике заметно меньше. Живой прогон
 * (2026-08, см. отчёт по задаче) дал пустой стоп-лист во всех бакетах именно
 * из-за этого: единственные теги, которым хватало пула на 36, — широкие
 * зонтичные ('metal', 'death metal', 'black metal'), которые владелец и так
 * честно держит в коллекции и которые в любом случае вырезает проверка
 * владения ниже, а не узкие соседние поджанры, которым и полагалось стать
 * стоп-тегами.
 *
 * Судить каждый хаб-тег СВОИМ порогом (0.2 от его же ~60 = 12, а не от 180)
 * чинит это: тег, сосредоточенный в одном хабе, набирает 12 из этого одного
 * хаба без разбавления двумя другими, несвязанными с ним хабами. Широкие
 * зонтичные теги при этом не проскакивают порог per-hub случайно — их
 * по-прежнему вырезает `ownedTagCounts` (владелец держит их по-настоящему),
 * а не порог частоты.
 *
 * Объединение — простая уния списков без повторного порога на пул: решение
 * "стоп-тег или нет" уже принято на уровне каждого хаба через `deriveStopTags`
 * (вызывается здесь с `limit: Infinity` — общий лимит применяется один раз,
 * после объединения, а не режет каждый хаб по отдельности до того, как
 * объединение случилось); пересчитывать это решение заново по объединённым
 * числам значило бы вернуть тот же дилюционный баг на другом шаге. Порядок
 * финального списка — по суммарному сырому счёту тега по ВСЕМ хабам бакета
 * (чисто для показа: что каузальнее в антипрофиле бакета в целом, а не
 * решение "качественный тег или нет" — оно уже принято выше), после чего
 * применяется общий `limit`.
 */
export function deriveStopTagsForBucket(input: BucketStopTagInput): string[] {
  const limit = input.limit ?? 40;

  const perHubResults = input.hubs.map((hub) =>
    deriveStopTags({
      hubTagCounts: hub.hubTagCounts,
      ownedTagCounts: input.ownedTagCounts,
      seedTags: input.seedTags,
      releasesSampled: hub.releasesSampled,
      locationVocabulary: input.locationVocabulary,
      minHubCount: input.minHubCount,
      minHubShare: input.minHubShare,
      minOwnedCount: input.minOwnedCount,
      limit: Number.POSITIVE_INFINITY,
    }),
  );

  /** Канонический ключ тега → сумма его сырых счётов по ВСЕМ хабам бакета — только для сортировки показа. */
  const pooledCount = new Map<string, number>();
  for (const hub of input.hubs) {
    for (const [tag, count] of Object.entries(hub.hubTagCounts)) {
      const key = canonicalizeTag(tag);
      pooledCount.set(key, (pooledCount.get(key) ?? 0) + count);
    }
  }

  // Один и тот же тег может независимо пройти в стоп-лист сразу нескольких
  // хабов бакета — объединяем по каноническому ключу, оставляя написание из
  // первого хаба, в котором тег встретился (детерминировано порядком
  // `input.hubs`, который задаёт вызывающий код через `hubSampleTags`).
  const seen = new Set<string>();
  const merged: { key: string; display: string }[] = [];
  for (const hubResult of perHubResults) {
    for (const display of hubResult) {
      const key = canonicalizeTag(display);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ key, display });
    }
  }

  return merged
    .sort((a, b) => (pooledCount.get(b.key) ?? 0) - (pooledCount.get(a.key) ?? 0))
    .slice(0, limit)
    .map((entry) => entry.display);
}
