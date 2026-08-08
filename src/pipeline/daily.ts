import { BUCKETS, orderSeedTagsBySpecificity } from '../profile/buckets.ts';
import type { BucketProfile, Profile } from '../profile/build.ts';
import { canonicalizeTag } from '../lib/tags.ts';
import type { Neighbor } from './neighbors.ts';
import { freshCandidates, type FreshDeps } from './fresh.ts';
import { archiveCandidates, type ArchiveDeps } from './archive.ts';
import { pickBest, type BucketInput } from './pick.ts';
import { buildCard, type Card } from '../telegram/card.ts';
import {
  handleUpdates,
  rememberSeen,
  type ApproveDeps,
  type ApproveState,
  type CardEdit,
} from '../telegram/approve.ts';
import type { InlineKeyboard, TelegramUpdate } from '../telegram/api.ts';

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

/** Минимальный срез Telegram-клиента, который умеет редактировать уже отправленное сообщение. */
export interface EditableTelegram {
  editMessageCaption(payload: {
    chat_id: string | number;
    message_id: number;
    caption: string;
    parse_mode?: 'HTML';
    reply_markup?: InlineKeyboard;
  }): Promise<unknown>;
  editMessageText(payload: {
    chat_id: string | number;
    message_id: number;
    text: string;
    parse_mode?: 'HTML';
    reply_markup?: InlineKeyboard;
  }): Promise<unknown>;
}

/**
 * Правит уже отправленную карточку владельца — методом, каким она была
 * отправлена изначально (`edit.hasPhoto`), а НЕ по тому, есть ли обложка у
 * кандидата, который в карточке показан сейчас: Telegram не даёт превратить
 * фото-сообщение в текстовое при редактировании и наоборот (см. комментарий
 * у `PendingCard.hasPhoto` в `../telegram/approve.ts`). Нужна ровно одному
 * сценарию — `replaceCard`, подмене кандидата кнопкой «другой», где карточка
 * остаётся жить с активными кнопками. Разобранные карточки не редактируются,
 * а удаляются (`deleteCard`).
 */
export function editCard(
  telegram: EditableTelegram,
  chatId: string | number,
  edit: CardEdit,
): Promise<unknown> {
  return edit.hasPhoto
    ? telegram.editMessageCaption({
        chat_id: chatId,
        message_id: edit.messageId,
        caption: edit.caption,
        parse_mode: 'HTML',
        reply_markup: edit.keyboard,
      })
    : telegram.editMessageText({
        chat_id: chatId,
        message_id: edit.messageId,
        text: edit.caption,
        parse_mode: 'HTML',
        reply_markup: edit.keyboard,
      });
}

/**
 * Две переменные окружения, без которых прогон не имеет смысла: токен бота
 * и чат владельца.
 *
 * Все отсутствующие переменные собираются в ОДНО сообщение об ошибке, а не
 * бросаются по одной: без этого владелец узнавал бы о недостающих
 * переменных по одной за прогон — завёл токен, перезапустил, узнал про
 * следующую недостающую, и так по кругу для каждой из пяти. Бросается это
 * до любого файла и любой сети (первая же строка `runDaily`, вызывающего
 * кода) — без рабочего токена бессмысленны даже безобидные операции вроде
 * чтения data/profile.json, а без него нельзя даже разобрать вчерашние
 * нажатия кнопок.
 */
export interface DailyConfig {
  botToken: string;
  ownerChatId: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DailyConfig {
  const missing: string[] = [];
  const read = (name: string): string => {
    const value = env[name];
    if (!value) missing.push(name);
    return value ?? '';
  };

  const botToken = read('TELEGRAM_BOT_TOKEN');
  const ownerChatId = read('OWNER_CHAT_ID');

  if (missing.length > 0) {
    throw new Error(`не заданы переменные окружения: ${missing.join(', ')}`);
  }
  return { botToken, ownerChatId };
}

/** Всё, что дневному прогону нужно от сети — Bandcamp и Telegram, — уже за интерфейсом, как и в остальном пайплайне. */
export interface DailyTelegramDeps extends ApproveDeps {
  getUpdates: (offset: number) => Promise<TelegramUpdate[]>;
  /** Отправляет новую карточку владельцу (sendPhoto или sendMessage — решает вызывающий код по `card.photo`). */
  sendCard: (card: Card) => Promise<{ messageId: number }>;
}

export interface DailyDeps {
  fresh: FreshDeps;
  archive: ArchiveDeps;
  /** URL всего, что уже есть у владельца — коллекция и вишлист вместе. */
  fetchOwnedUrls: () => Promise<string[]>;
  /** Субдомены подписок владельца — обходятся один раз за прогон (см. `runDaily`). */
  fetchFollowSubdomains: () => Promise<string[]>;
  telegram: DailyTelegramDeps;
  persistState: (state: ApproveState) => Promise<void>;
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
  /** Сколько минут ждать нажатий после отправки карточки, прежде чем выйти. */
  listenMinutes: number;
}

/**
 * Сносит из лички карточку прошлого захода, если владелец так и не нажал на
 * неё за отведённые минуты. Смысл — к моменту отправки сегодняшнего пика в
 * личке не должно висеть ничего, кроме того, что ещё надо послушать.
 *
 * Момент вызова не произволен: строго ПОСЛЕ дренажа вчерашних нажатий (иначе
 * снесли бы карточку, нажатие по которой ещё лежит в очереди `getUpdates`, и
 * потеряли бы и само нажатие, и его след в `feedbackTags`) и ДО сбора
 * сегодняшних кандидатов.
 *
 * Показанным (`rememberSeen`) помечается НЕ тот кандидат, что лежит в карточке
 * на момент сноса, а `shownBeforeRun` — то, что реально висело у владельца
 * перед этим заходом. Разница не косметическая. Дренаж (шаг 1) мог разобрать
 * нажатие «Другой», пришедшее уже после выхода прошлого джоба: `handleNext`
 * пометит показанным старого кандидата (правильно — его владелец видел),
 * подменит содержимое карточки на альтернативу и оставит её в `pending`. Через
 * долю секунды эта же карточка сносится здесь — и альтернативу владелец не
 * увидит ни секунды. Пометить её показанной значило бы выжечь из конечного
 * пула релиз, которого никто не видел: спека называет истощение пула главным
 * риском схемы, а тут он тратился бы вхолостую и молча.
 *
 * Неудача удаления не фатальна: сообщение мог снести сам владелец руками, а
 * состояние к этому моменту уже согласовано. Ошибка логируется, прогон идёт
 * дальше.
 */
async function sweepStaleMessages(
  state: ApproveState,
  deps: DailyDeps,
  shownBeforeRun: readonly string[],
): Promise<void> {
  const messageIds = state.pending.map((card) => card.messageId);
  if (messageIds.length === 0) return;

  for (const url of shownBeforeRun) rememberSeen(state, url);

  for (const messageId of messageIds) {
    try {
      await deps.telegram.deleteCard(messageId);
    } catch (error) {
      console.error(`daily: не удалось снести сообщение ${messageId} из лички`, error);
    }
  }

  state.pending = [];
  await deps.persistState(state);
}

/**
 * Заход подборщика: разобрать нажатия с прошлого раза, вычистить личку,
 * собрать кандидатов по четырём бакетам, отправить владельцу ОДНУ карточку —
 * лучшую из всех бакетов разом, — подождать реакции и выйти, оставив
 * состояние на диске.
 *
 * Порядок шагов — не произвольный:
 * 1. Дренаж вчерашнего backlog идёт ПЕРВЫМ и целиком, до единого сетевого
 *    похода за кандидатами: то, что владелец уже разобрал руками (seen),
 *    обязано быть учтено в exclude-множестве, иначе сегодняшний отбор
 *    рискует предложить то же самое повторно под новым messageId.
 * 1b. Подчистка хвостов (`sweepStaleMessages`) — сразу после дренажа, чтобы
 *    сегодняшняя карточка легла в пустую личку.
 * 2. Сбор кандидатов и ОДИН пик. Бакеты здесь — уже не четыре независимых
 *    отбора (каналов, под которые они заводились, больше нет), а всего лишь
 *    четыре способа набрать кандидатов и четыре набора весов, которыми их
 *    скорить: собранное отдаётся в `pickBest` (`./pick.ts`) одним куском, и
 *    победитель ровно один на весь заход — либо ни одного, если даже лучший
 *    не дотянул до `options.minTotal`, и тогда заход молчит. Подписки
 *    обходятся ОДИН раз на весь прогон (см. "Решения, принятые по ходу
 *    реализации", п.2), архивный пул тоже строится один раз с запасом и
 *    делится между бакетами скорингом (п.6). Ошибка сбора одного бакета
 *    (сеть, discover) не должна ронять остальные три — ловится и логируется
 *    точечно, прогон идёт дальше с тем, что успело собраться.
 * 3. Отправка карточки — сразу после неё состояние персистится: убитый
 *    посреди дня джоб не должен ни потерять отправленную карточку из
 *    pending, ни отправить её повторно завтра.
 * 4. Опрос — держится на long-poll самого `getUpdates` (см. комментарий у
 *    `Telegram.getUpdates` в `../telegram/api.ts`, timeout по умолчанию
 *    30с): отдельный `sleep` между вызовами не нужен и только тратил бы
 *    время сверх long-poll. Выходит раньше срока, если разбирать больше
 *    нечего (`state.pending` опустел). Всё, что осталось в `pending` на
 *    выходе, остаётся у владельца с живыми кнопками — следующий прогон
 *    разберёт нажатие через дренаж backlog на шаге 1.
 */
export async function runDaily(
  profile: Profile,
  neighbors: Neighbor[],
  state: ApproveState,
  deps: DailyDeps,
  options: DailyOptions,
): Promise<void> {
  const approveDeps: ApproveDeps = {
    replaceCard: deps.telegram.replaceCard,
    deleteCard: deps.telegram.deleteCard,
    ack: deps.telegram.ack,
  };

  // Что реально висело у владельца до этого захода — снимок делается ДО
  // дренажа, потому что дренаж может подменить кандидата в карточке кнопкой
  // «Другой». Только это владелец действительно видел; см. `sweepStaleMessages`.
  const shownBeforeRun = state.pending.map((card) => card.candidate.url);

  // 1. Разобрать нажатия, накопившиеся с прошлого захода — весь backlog, не одна страница.
  let backlog = await deps.telegram.getUpdates(state.lastUpdateId + 1);
  while (backlog.length > 0) {
    await handleUpdates(backlog, state, approveDeps);
    await deps.persistState(state);
    backlog = await deps.telegram.getUpdates(state.lastUpdateId + 1);
  }

  // 1b. Снести всё, что осталось в личке с прошлых заходов. После этого
  // state.pending пуст, а URL показанных карточек лежат в state.seen — то
  // есть попадут в exclude-множество ниже наравне с разобранным вручную.
  await sweepStaleMessages(state, deps, shownBeforeRun);

  // 2. Собрать сегодняшних кандидатов и выбрать из них одного.
  const now = deps.now();
  const ownedUrls = await deps.fetchOwnedUrls();
  const excluded = new Set([...state.seen, ...ownedUrls]);

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
  // оставить три бакета из четырёх вовсе без архивных кандидатов, если
  // топ голосов забьёт один жанр.
  const archivePool = await archiveCandidates(deps.archive, {
    neighbors,
    exclude: excluded,
    limit: options.archivePoolLimit,
  });

  // Бакеты здесь — только источники кандидатов и наборы весов: каждый
  // добирает свой хаб-свежак к общим (собранным выше один раз на прогон)
  // подпискам и архиву, а решение, чей кандидат уйдёт владельцу, принимает
  // один `pickBest` уже над всеми четырьмя входами разом.
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
      // остальные три — они читают из независимо собранных пулов.
      console.error(`daily: сбор кандидатов бакета ${bucket.id} упал, бакет пропущен на сегодня`, error);
    }
  }

  const pickOptions = {
    buckets: bucketInputs,
    // `?? []` — та же защита, что и у остальных полей, читанных через
    // readJson (см. комментарий у `Profile.hardRejectTags` в
    // ../profile/build.ts и у seedTags выше в этом файле): readJson не
    // валидирует форму файла против интерфейса, а data/profile.json
    // хозяин правит руками — устаревший файл без этого поля не должен
    // ронять весь дневной прогон, только тихо остаться без защиты от
    // компиляций до следующей правки файла.
    hardRejectTags: profile.hardRejectTags ?? [],
    seen: excluded,
    context: { labels: profile.labels, tagPenalties: state.feedbackTags },
    alternativesCount: options.alternativesCount,
    minTotal: options.minTotal,
  };

  // Запрет на повтор жанра — предпочтение, а не жёсткое правило, и снимается
  // сам, если из-за него заход остался бы вообще без пика.
  //
  // Без этого отката запрет умеет запирать подборщика намертво: он снимается
  // только состоявшимся пиком, а молчаливый заход `lastBucket` не трогает. Если
  // единственный жанр, дающий кандидатов выше порога, — как раз забаненный (у
  // владельца заведомо самый плотный бакет краста, а остальным трём набрать 1.5
  // удаётся не каждый день), бот замолкает НАВСЕГДА, и никакой следующий заход
  // это не расколдует. Решение по спеке звучит как «жанр не повторяется два
  // захода подряд», то есть запрет на один шаг — а не «пока не найдётся другой
  // жанр, чего бы это ни стоило».
  //
  // Повтор жанра здесь — меньшее зло, чем тишина: молчание задумано как ответ
  // на «сегодня нет ничего стоящего», а не на «стоящее есть, но не того цвета».
  let best = pickBest({ ...pickOptions, excludeBucket: state.lastBucket });
  if (!best && state.lastBucket !== undefined) {
    best = pickBest(pickOptions);
    if (best) {
      console.log(`daily: кроме бакета ${best.bucket} сегодня нечего предложить — запрет на повтор снят`);
    }
  }

  // Ничего не дотянуло до порога — молчим. Никакого «сегодня пусто» в личку:
  // это ровно тот шум, ради устранения которого вся схема и переделана.
  if (!best) {
    console.log('daily: ничего выше порога, заход молчит');
    return;
  }

  // 3. Отправить карточку победителя и сразу же зафиксировать состояние:
  // если джоб убьют между отправкой и персистом, карточка останется висеть у
  // владельца с живыми кнопками, а следующий заход о ней не узнает — не
  // разберёт нажатие, не снесёт хвост и ничто не помешает ему прислать тот же
  // релиз повторно.
  const card = buildCard(best.candidate, best.bucket, best.matchedTags);
  const sent = await deps.telegram.sendCard(card);
  state.pending.push({
    bucket: best.bucket,
    messageId: sent.messageId,
    hasPhoto: card.photo !== null,
    candidate: best.candidate,
    matchedTags: best.matchedTags,
    alternatives: best.alternatives,
  });
  // Запрет на повтор жанра ставится только состоявшимся пиком — молчаливый
  // заход прошлый запрет не снимает (см. `ApproveState.lastBucket`).
  state.lastBucket = best.bucket;
  await deps.persistState(state);

  // 4. Ждать нажатий примерно options.listenMinutes. getUpdates уже держит
  // соединение открытым до 30с сама (см. комментарий у Telegram.getUpdates
  // в ../telegram/api.ts) — отдельный sleep между вызовами не нужен и
  // только тратил бы время стены сверх long-poll. Выходим раньше срока,
  // если разбирать больше нечего.
  const until = deps.now().getTime() + options.listenMinutes * 60_000;
  while (state.pending.length > 0 && deps.now().getTime() < until) {
    const updates = await deps.telegram.getUpdates(state.lastUpdateId + 1);
    if (updates.length === 0) continue;
    await handleUpdates(updates, state, approveDeps);
    await deps.persistState(state);
  }
  // Если карточка осталась в state.pending, она висит у владельца с живыми
  // кнопками; состояние уже сохранено. Следующий заход разберёт нажатие по
  // ней через дренаж backlog на шаге 1, а если нажатия так и не было —
  // снесёт её подчисткой на шаге 1b.
}
