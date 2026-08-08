import { BUCKETS, orderSeedTagsBySpecificity } from '../profile/buckets.ts';
import type { BucketProfile, Profile } from '../profile/build.ts';
import { canonicalizeTag } from '../lib/tags.ts';
import type { Neighbor } from './neighbors.ts';
import { freshCandidates, type FreshDeps } from './fresh.ts';
import { archiveCandidates, type ArchiveDeps } from './archive.ts';
import { pickBest, type BucketInput } from './pick.ts';
import type { Candidate } from '../bandcamp/types.ts';
import type { PickerContext, PickRequest, SiteCandidate } from '../site/api.ts';

/**
 * Опорные теги бакета из data/profile.json (см. `buildProfile` в
 * `../profile/build.ts`) держат вес 0.5, не-опорные нормализованы к
 * максимуму 1 — сортировка чисто по весу поэтому систематически топит
 * опорные теги под производными: живой прогон (2026-08) отдал для
 * hardcore-punk хаб-теги `post-punk, d-beat, primative, crust` — ни одного
 * панк/хардкор-тега, потому что все четыре его опорных тега, переживших
 * порог, сидят ровно на 0.5, а четыре производных тега обогнали их весом
 * от 0.79 до 1. В результате дневной поиск по бакету hardcore-punk ни разу
 * не запрашивает хаб самого хардкора — новая группа жанра, ещё не
 * попавшая в подписки, эффективно никогда не всплывёт.
 *
 * Тот же класс бага уже чинился один раз для антипрофиля — см.
 * `hubSampleTags`/`orderSeedTagsBySpecificity` в `./buckets.ts`: голые
 * однословные seed-теги ('punk', 'hardcore', 'metal') — Bandcamp-омонимы с
 * хабом на сотни тысяч релизов, поэтому составные seed-теги предпочитаются
 * голым при резервировании. Эта функция использует тот же helper для той
 * же выборки, а не переизобретает своё правило заново.
 *
 * Слоты `limit` делятся пополам (округление вверх при нечётном limit) —
 * половина ЖЁСТКО зарезервирована под seed-теги бакета (свои собственные
 * жанровые маркеры, порядок — по специфичности, см. выше), вторая половина
 * — top производных тегов профиля по весу. Производные теги не бесполезны:
 * это то, как бакет находит смежные сцены, которые владельцу реально
 * нравятся (соседние поджанры, тусовки лейблов), и вытеснять их совсем в
 * пользу seed-тегов значило бы вернуть бакет к чистому поиску по жанровому
 * ярлыку, без открытия соседнего. Резерв — гарантия нижней границы для
 * своего жанра, а не запрет на производные: если seed-тегов у бакета
 * меньше, чем зарезервированные слоты, лишние слоты достаются производным
 * без остатка (см. `seedPart.length` ниже).
 *
 * Если производных тегов не хватает, чтобы добрать limit (свежепостроенный
 * бакет, или бакет, у которого buildProfile вообще не насчитал ни одного
 * тега сверх порога minReleases), остаток добирается ОСТАЛЬНЫМИ seed-
 * тегами бакета (тот же порядок по специфичности) — это тот же фолбэк на
 * seedTags, что был раньше для случая полностью пустого профиля, просто
 * применяется к остатку лимита, а не ко всему списку целиком.
 */
export function hubTagsForBucket(
  bucketProfile: BucketProfile,
  seedTags: readonly string[],
  limit: number,
): string[] {
  if (limit <= 0) return [];

  const orderedSeed = orderSeedTagsBySpecificity(seedTags);
  const seedSlots = Math.ceil(limit / 2);
  const seedPart = orderedSeed.slice(0, seedSlots);

  const seedCanonical = new Set(seedTags.map(canonicalizeTag));
  const derivedPart = Object.entries(bucketProfile.tags)
    .filter(([tag, weight]) => weight > 0 && !seedCanonical.has(canonicalizeTag(tag)))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit - seedPart.length)
    .map(([tag]) => tag);

  const combined = [...seedPart, ...derivedPart];
  if (combined.length >= limit) return combined;

  // Добор оставшимися seed-тегами (в том же порядке специфичности), если и
  // резерв, и производные вместе не набрали limit.
  const used = new Set(combined.map(canonicalizeTag));
  for (const tag of orderedSeed.slice(seedSlots)) {
    if (combined.length >= limit) break;
    const key = canonicalizeTag(tag);
    if (used.has(key)) continue;
    used.add(key);
    combined.push(tag);
  }
  return combined;
}

/** Адрес сайта по умолчанию — свой собственный, менять его в переменной окружения нужно только для отладки против localhost. */
export const DEFAULT_SITE_URL = 'https://gigamike666.com';

/**
 * Конфигурация прогона: куда ходить и чем представляться.
 *
 * Обязательная переменная ровно одна — секрет: без него сайт ответит 401 на
 * первом же запросе, и заход всё равно упадёт, только позже и с менее внятной
 * ошибкой. Проверяется до любого файла и любой сети (первая строка
 * `bin/daily.ts`): собирать профиль и обходить Bandcamp по полчаса, чтобы
 * упереться в 401 на отправке, — худший из возможных порядков.
 *
 * `SITE_URL` необязателен: адрес сайта известен и не меняется, а переменная
 * существует затем, чтобы прогнать джоб против локального `next dev`.
 */
export interface DailyConfig {
  siteUrl: string;
  pickerSecret: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DailyConfig {
  const pickerSecret = env.PICKER_SECRET;
  if (!pickerSecret) {
    throw new Error('не задана переменная окружения PICKER_SECRET — без неё сайт ответит 401');
  }
  return { siteUrl: env.SITE_URL || DEFAULT_SITE_URL, pickerSecret };
}

/** Всё, что прогону нужно от сайта: прочитать прошлое и отдать победителя. Форма — контракт `../site/api.ts`. */
export interface DailySiteDeps {
  readContext: () => Promise<PickerContext>;
  sendPick: (pick: PickRequest) => Promise<{ messageId: number }>;
}

export interface DailyDeps {
  fresh: FreshDeps;
  archive: ArchiveDeps;
  /** URL всего, что уже есть у владельца — коллекция и вишлист вместе. */
  fetchOwnedUrls: () => Promise<string[]>;
  /** Субдомены подписок владельца — обходятся один раз за прогон (см. `runDaily`). */
  fetchFollowSubdomains: () => Promise<string[]>;
  site: DailySiteDeps;
  now: () => Date;
}

export interface DailyOptions {
  /** Свежак старше стольких дней не считается свежим — см. `FreshOptions.maxAgeDays`. */
  maxAgeDays: number;
  /** Предзаказ дальше стольких дней в будущем ещё не считается свежим — см. `FreshOptions.maxFutureDays`. */
  maxFutureDays: number;
  /** Размер общего архивного пула за прогон — генерозный, делится между всеми бакетами скорингом (см. "Решения", п.6). */
  archivePoolLimit: number;
  /** Запас "другой кандидат" у отправленной карточки — см. `BestPick.alternatives` в `./pick.ts`. */
  alternativesCount: number;
  /** Сколько верхних тегов профиля бакета опрашивать в Discover как хаб-теги. */
  hubTagsPerBucket: number;
  /** Ниже этого total прогон молчит и не шлёт ничего вовсе. */
  minTotal: number;
}

/**
 * Кандидат в форме, которую принимает сайт.
 *
 * Отображение явное, а не `{...candidate}`: у внутреннего `Candidate` есть
 * поля, сайту ненужные (`itemId`, `alsoCollected`, `neighborWeight` — всё это
 * механика отбора), и утекать в чужой контракт они не должны. Заодно
 * компилятор ловит расхождение формы здесь, у себя, а не ответом 400 в проде.
 */
function toSiteCandidate(candidate: Candidate): SiteCandidate {
  return {
    url: candidate.url,
    title: candidate.title,
    artist: candidate.artist,
    label: candidate.label,
    tags: candidate.tags,
    releasedAt: candidate.releasedAt,
    artUrl: candidate.artUrl,
    origin: candidate.origin,
  };
}

/**
 * Что штрафовать, если владелец нажмёт «Не моё»: совпавшие теги МИНУС опорные
 * теги бакета.
 *
 * Вычитание обязательно. Опорный тег бакета несёт каждый его релиз по
 * построению (`score()` в `../profile/score.ts` вообще отбраковывает кандидата
 * без единого опорного тега), так что без вычитания любой отказ штрафовал бы
 * именно этот вездесущий тег — а не то, что владельцу реально не понравилось.
 * За десяток отказов вес опорного тега уехал бы в пол, и бакет отбраковал бы
 * сам себя целиком.
 *
 * Считается здесь, а не на сайте: опорные теги — это `seedTags` из
 * `../profile/buckets.ts`, они живут в этом репозитории и здесь же меняются.
 * Сравнение каноническое (`canonicalizeTag`), потому что тег релиза и
 * seed-тег — это два независимых написания одного и того же ('d-beat' против
 * 'dbeat'), и различие в дефисе не должно превращать опорный тег в
 * штрафуемый.
 */
export function penaltyTagsFor(matchedTags: readonly string[], seedTags: readonly string[]): string[] {
  const seed = new Set(seedTags.map(canonicalizeTag));
  return matchedTags.filter((tag) => !seed.has(canonicalizeTag(tag)));
}

/**
 * Заход подборщика: спросить у сайта, что владельцу уже показывали, собрать
 * кандидатов по всем бакетам, выбрать ОДНОГО лучшего из всех разом и отдать
 * его сайту — или промолчать, если ничего не дотянуло до порога.
 *
 * Этот репозиторий больше не бот и не хранит состояния. Карточку, кнопки,
 * диалог описания и пост на сайте делает `gigamike666.com`: у него вебхук,
 * живой круглосуточно, а джоб живёт минуты — нажатие «Другой» вечером должно
 * отвечать сразу, а не через двенадцать часов, когда проснётся следующий
 * заход. Поэтому здесь нет ни ожидания нажатий, ни дренажа backlog, ни
 * подчистки хвостов: всё это было следствием того, что кнопки обслуживал
 * смертный процесс.
 *
 * Порядок шагов:
 * 1. Контекст с сайта (показанное, штрафы по тегам, жанр прошлого пика) —
 *    ПЕРВЫМ, до единого сетевого похода за кандидатами: показанное обязано
 *    попасть в exclude-множество, иначе заход честно предложит то, что
 *    владелец уже видел. Провал этого запроса роняет прогон (см. `#request`
 *    в `../site/api.ts`): пустой контекст выглядел бы как «ничего не
 *    показывали» и был бы хуже красного джоба.
 * 2. Сбор кандидатов и ОДИН пик. Бакеты здесь — не независимые отборы, а
 *    способы набрать кандидатов и наборы весов, которыми их скорить:
 *    собранное уходит в `pickBest` (`./pick.ts`) одним куском, и победитель
 *    ровно один на весь заход. Подписки обходятся ОДИН раз на прогон,
 *    архивный пул тоже строится один раз с запасом и делится между бакетами
 *    скорингом. Ошибка сбора одного бакета (сеть, discover) не роняет
 *    остальные — ловится и логируется точечно.
 * 3. Отдать победителя сайту. Всё остальное — его забота.
 */
export async function runDaily(
  profile: Profile,
  neighbors: Neighbor[],
  deps: DailyDeps,
  options: DailyOptions,
): Promise<void> {
  // 1. Что известно о прошлом. Сайт — единственный источник правды по
  // показанному и штрафам; на диске этого репозитория состояния больше нет.
  const context = await deps.site.readContext();

  const now = deps.now();
  const ownedUrls = await deps.fetchOwnedUrls();
  const excluded = new Set([...context.seen, ...ownedUrls]);

  // Жанр прошлого пика приходит строкой и сверяется со списком бакетов, а не
  // приводится к `BucketId` кастом: в Neon лежит то, что записал прошлый
  // заход, и переименование или снятие бакета сделает эту строку чужой.
  // Неизвестный id просто перестаёт что-либо запрещать — это ровно то
  // поведение, которое нужно: запрет на повтор жанра, которого больше нет в
  // отборе, не имеет смысла.
  const lastBucket = BUCKETS.find((bucket) => bucket.id === context.lastBucket)?.id;

  // Подписки — один сетевой обход на весь прогон (см. п.2 решений), а не
  // по разу на бакет: freshCandidates сама не кэширует и не помнит
  // прошлые вызовы (см. комментарий у `FreshOptions.subdomains`), так что
  // раздать один и тот же результат всем бакетам — забота этого кода.
  const followSubdomains = await deps.fetchFollowSubdomains();
  const followsFresh = await freshCandidates(deps.fresh, {
    tags: [],
    subdomains: followSubdomains,
    now,
    maxAgeDays: options.maxAgeDays,
    maxFutureDays: options.maxFutureDays,
  });

  // Архивный пул — тоже один раз за прогон, с запасом (см. п.6 решений):
  // голоса соседей genre-blind, узкий пул на один вызов селектора мог бы
  // оставить почти все бакеты вовсе без архивных кандидатов, если топ
  // голосов забьёт один жанр.
  const archivePool = await archiveCandidates(deps.archive, {
    neighbors,
    exclude: excluded,
    limit: options.archivePoolLimit,
  });

  // Бакеты здесь — только источники кандидатов и наборы весов: каждый
  // добирает свой хаб-свежак к общим (собранным выше один раз на прогон)
  // подпискам и архиву, а решение, чей кандидат уйдёт владельцу, принимает
  // один `pickBest` уже над всеми входами разом.
  const bucketInputs: BucketInput[] = [];
  for (const bucket of BUCKETS) {
    try {
      const bucketProfile = profile.buckets[bucket.id];
      const hubTags = hubTagsForBucket(bucketProfile, bucket.seedTags, options.hubTagsPerBucket);
      const hubFresh = await freshCandidates(deps.fresh, {
        tags: hubTags,
        subdomains: [],
        now,
        maxAgeDays: options.maxAgeDays,
        maxFutureDays: options.maxFutureDays,
      });
      bucketInputs.push({
        id: bucket.id,
        profile: bucketProfile,
        seedTags: bucket.seedTags,
        fresh: [...hubFresh, ...followsFresh],
        archive: archivePool,
      });
    } catch (error) {
      // Один упавший бакет (сеть, discover) не должен утащить с собой
      // остальные — они читают из независимо собранных пулов.
      console.error(`daily: сбор кандидатов бакета ${bucket.id} упал, бакет пропущен на сегодня`, error);
    }
  }

  const pickOptions = {
    buckets: bucketInputs,
    // `?? []` — та же защита, что и у остальных полей, читанных через
    // readJson (см. комментарий у `Profile.hardRejectTags` в
    // ../profile/build.ts): readJson не валидирует форму файла против
    // интерфейса, а data/profile.json хозяин правит руками — устаревший
    // файл без этого поля не должен ронять весь прогон, только тихо
    // остаться без защиты от компиляций до следующей правки файла.
    hardRejectTags: profile.hardRejectTags ?? [],
    seen: excluded,
    context: { labels: profile.labels, tagPenalties: context.feedbackTags },
    alternativesCount: options.alternativesCount,
    minTotal: options.minTotal,
  };

  // Запрет на повтор жанра — предпочтение, а не жёсткое правило, и снимается
  // сам, если из-за него заход остался бы вообще без пика.
  //
  // Без этого отката запрет умеет запирать подборщика намертво: он снимается
  // только состоявшимся пиком, а молчаливый заход `last_bucket` не трогает. Если
  // единственный жанр, дающий кандидатов выше порога, — как раз забаненный (у
  // владельца заведомо самый плотный бакет краста, а остальным набрать 1.5
  // удаётся не каждый день), бот замолкает НАВСЕГДА, и никакой следующий заход
  // это не расколдует. Решение по спеке звучит как «жанр не повторяется два
  // захода подряд», то есть запрет на один шаг — а не «пока не найдётся другой
  // жанр, чего бы это ни стоило».
  //
  // Повтор жанра здесь — меньшее зло, чем тишина: молчание задумано как ответ
  // на «сегодня нет ничего стоящего», а не на «стоящее есть, но не того цвета».
  let best = pickBest({ ...pickOptions, excludeBucket: lastBucket });
  if (!best && lastBucket !== undefined) {
    best = pickBest(pickOptions);
    if (best) {
      console.log(`daily: кроме бакета ${best.bucket} сегодня нечего предложить — запрет на повтор снят`);
    }
  }

  // Ничего не дотянуло до порога — молчим, и на сайт не ходим вовсе. Никакого
  // «сегодня пусто» в личку: это ровно тот шум, ради устранения которого вся
  // схема и переделана.
  if (!best) {
    console.log('daily: ничего выше порога, заход молчит');
    return;
  }

  // 3. Отдать победителя сайту. Дальше карточка, кнопки и пост — его дело;
  // здесь заход заканчивается, ничего не сохраняя и ничего не дожидаясь.
  const bucket = BUCKETS.find((entry) => entry.id === best.bucket)!;
  const sent = await deps.site.sendPick({
    bucket: best.bucket,
    bucketTitle: bucket.title,
    candidate: toSiteCandidate(best.candidate),
    penaltyTags: penaltyTagsFor(best.matchedTags, bucket.seedTags),
    total: best.total,
    alternatives: best.alternatives.map(toSiteCandidate),
  });
  console.log(`daily: ${best.candidate.artist} — ${best.candidate.title} (${bucket.title}, ${best.total.toFixed(2)}) отправлен, message_id ${sent.messageId}`);
}
