import type { BucketId, Candidate } from '../bandcamp/types.ts';
import { BUCKETS, orderSeedTagsBySpecificity, type BucketDef } from '../profile/buckets.ts';
import type { BucketProfile, Profile } from '../profile/build.ts';
import { canonicalizeTag } from '../lib/tags.ts';
import type { Neighbor } from './neighbors.ts';
import { freshCandidates, type FreshDeps } from './fresh.ts';
import { archiveCandidates, type ArchiveDeps } from './archive.ts';
import { selectForBucket, type BucketSelection } from './select.ts';
import { buildCard, type Card } from '../telegram/card.ts';
import {
  handleUpdates,
  type ApproveDeps,
  type ApproveState,
  type CardEdit,
  type PendingCard,
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
 * от 0.79 до 1. В результате дневной поиск по каналу hardcore-punk ни разу
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
 * пользу seed-тегов значило бы вернуть канал к чистому поиску по жанровому
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

/**
 * Что сказать владельцу, если у бакета сегодня нет ни одной карточки —
 * ни свежей, ни архивной. `selectForBucket` различает "нечего было
 * предложить" (пул пуст на входе: подписки/хаб не выдали ничего, или
 * архивный пул для прогона уже пуст) от "предлагали, но не подошло"
 * (профиль отбраковал скорингом, или всё уже показывалось) — молчание
 * подменило бы эти два случая одним и тем же пустым результатом, а они
 * требуют разной реакции владельца: первое обычное и ожидаемое, второе
 * стоит заметить (профиль мог перетянуть стоп-теги, или день оказался
 * из ряда вон скудным).
 *
 * Если хотя бы один из двух пулов дал карточку — бакет НЕ молчит (карточка
 * сама по себе уже сообщение), и здесь возвращается null: отдельная
 * заметка "второй пул сегодня пуст" ничего не добавляет, кроме шума на
 * ровном месте — так бывает почти каждый день у архива или у свежака.
 */
export function bucketEmptyMessage(bucket: BucketDef, selection: BucketSelection): string | null {
  if (selection.fresh.status === 'picked' || selection.archive.status === 'picked') return null;
  const describe = (label: string, outcome: BucketSelection['fresh']): string =>
    outcome.status === 'not-offered'
      ? `${label}: сегодня нечего было предложить`
      : `${label}: кандидаты были, но профиль отбраковал всё`;
  return [
    `${bucket.channelTitle}: сегодня без карточек.`,
    describe('свежак', selection.fresh),
    describe('архив', selection.archive),
  ].join('\n');
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
 * у `PendingCard.hasPhoto` в `../telegram/approve.ts`). Используется и для
 * `replaceCard` (подмена кандидата, клавиатура жива), и для `closeCard`
 * (финализация, клавиатура снята) — `approve.ts` уже собирает нужный вариант
 * `CardEdit` под оба случая, этой функции всё равно, зовут её откуда.
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
 * Пять переменных окружения, без которых прогон не имеет смысла: токен
 * бота, чат владельца и по одному chat_id канала на каждый бакет из
 * `BUCKETS` (см. `../profile/buckets.ts` — сейчас их четыре, включая
 * `black-metal`/`BLACK_METAL_CHANNEL_ID`, но список читается оттуда, а не
 * дублируется здесь именами). Список собирается generично по `BUCKETS`
 * именно затем, чтобы добавление пятого бакета само по себе расширило
 * список нужных переменных, без правки этой функции.
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
  channelIdByBucket: Map<BucketId, string>;
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
  const channelIdByBucket = new Map<BucketId, string>();
  for (const bucket of BUCKETS) {
    channelIdByBucket.set(bucket.id, read(bucket.channelEnv));
  }

  if (missing.length > 0) {
    throw new Error(`не заданы переменные окружения: ${missing.join(', ')}`);
  }
  return { botToken, ownerChatId, channelIdByBucket };
}

/** Всё, что дневному прогону нужно от сети — Bandcamp и Telegram, — уже за интерфейсом, как и в остальном пайплайне. */
export interface DailyTelegramDeps extends ApproveDeps {
  getUpdates: (offset: number) => Promise<TelegramUpdate[]>;
  /** Отправляет новую карточку владельцу (sendPhoto или sendMessage — решает вызывающий код по `card.photo`). */
  sendCard: (card: Card) => Promise<{ messageId: number }>;
  /** Служебное сообщение владельцу вне карточек — например, "у бакета сегодня пусто". */
  notifyOwner: (text: string) => Promise<void>;
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
  /** Запас "другой кандидат" на пул. */
  alternativesCount: number;
  /** Сколько верхних тегов профиля бакета опрашивать в Discover как хаб-теги. */
  hubTagsPerBucket: number;
  /** Сколько минут ждать нажатий после отправки карточек, прежде чем выйти. */
  listenMinutes: number;
}

/**
 * Дневной прогон: разобрать вчерашние нажатия, собрать сегодняшних
 * кандидатов по четырём бакетам, отправить владельцу карточки, подождать
 * реакции и выйти, оставив состояние на диске.
 *
 * Порядок шагов — не произвольный:
 * 1. Дренаж вчерашнего backlog идёт ПЕРВЫМ и целиком, до единого сетевого
 *    похода за кандидатами: то, что владелец уже разобрал руками (posted/
 *    seen), обязано быть учтено в exclude-множестве, иначе сегодняшний
 *    отбор рискует предложить то же самое повторно под новым messageId.
 * 2. Сбор кандидатов — подписки обходятся ОДИН раз на весь прогон (см.
 *    "Решения, принятые по ходу реализации", п.2), архивный пул тоже
 *    строится один раз с запасом и делится между бакетами скорингом
 *    (п.6). Ошибка сбора одного бакета (сеть, discover) не должна ронять
 *    остальные три — ловится и логируется точечно, прогон идёт дальше.
 * 3. Отправка карточек — сразу после каждой успешной отправки состояние
 *    персистится: убитый посреди дня джоб не должен ни потерять уже
 *    отправленные карточки из pending, ни отправить их повторно завтра.
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
    postToChannel: deps.telegram.postToChannel,
    replaceCard: deps.telegram.replaceCard,
    closeCard: deps.telegram.closeCard,
    ack: deps.telegram.ack,
  };

  // 1. Разобрать нажатия, накопившиеся со вчера — весь backlog, не одна страница.
  let backlog = await deps.telegram.getUpdates(state.lastUpdateId + 1);
  while (backlog.length > 0) {
    await handleUpdates(backlog, state, approveDeps, deps.now());
    await deps.persistState(state);
    backlog = await deps.telegram.getUpdates(state.lastUpdateId + 1);
  }

  // 2. Собрать сегодняшних кандидатов.
  const now = deps.now();
  const ownedUrls = await deps.fetchOwnedUrls();
  // Карточки, зависшие в pending с прошлого прогона (владелец ещё не
  // ответил), исключаются наравне с уже показанным (state.seen) и уже
  // имеющимся (ownedUrls) — иначе тот же релиз мог бы получить второй
  // pending-дубль под другим messageId, пока первый ждёт ответа.
  const pendingUrls = state.pending.map((card) => card.candidate.url);
  const excluded = new Set([...state.seen, ...pendingUrls, ...ownedUrls]);

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

  // Растёт по ходу цикла: пик одного бакета исключается из предложения
  // следующим — иначе один и тот же кроссовер-релиз (crust/hardcore и
  // т.п.) мог бы уйти владельцу дважды в один день под двумя карточками.
  const shown = new Set(excluded);

  for (const bucket of BUCKETS) {
    let selection: BucketSelection;
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
      selection = selectForBucket({
        bucket: bucketProfile,
        seedTags: bucket.seedTags,
        fresh: [...hubFresh, ...followsFresh],
        archive: archivePool,
        seen: shown,
        context: { labels: profile.labels, tagPenalties: state.feedbackTags },
        alternativesCount: options.alternativesCount,
      });
    } catch (error) {
      // Один упавший бакет (сеть, discover) не должен утащить с собой
      // остальные три — они читают из независимо собранных пулов.
      console.error(`daily: сбор кандидатов бакета ${bucket.id} упал, бакет пропущен на сегодня`, error);
      continue;
    }

    let sentAny = false;
    for (const outcome of [selection.fresh, selection.archive]) {
      if (outcome.status !== 'picked') continue;
      try {
        const card = buildCard(outcome.candidate, bucket.id, outcome.matchedTags);
        const sent = await deps.telegram.sendCard(card);
        const pendingCard: PendingCard = {
          bucket: bucket.id,
          messageId: sent.messageId,
          hasPhoto: card.photo !== null,
          candidate: outcome.candidate,
          matchedTags: outcome.matchedTags,
          alternatives: outcome.alternatives,
        };
        state.pending.push(pendingCard);
        shown.add(outcome.candidate.url);
        sentAny = true;
        // Персист сразу после каждой отправленной карточки — не после
        // всего бакета и не после всех четырёх: если джоб убьют на
        // следующей карточке, уже отправленные не потеряются из pending
        // и не уйдут владельцу повторно завтра.
        await deps.persistState(state);
      } catch (error) {
        console.error(`daily: не удалось отправить карточку бакета ${bucket.id}`, error);
      }
    }

    if (!sentAny) {
      const note = bucketEmptyMessage(bucket, selection);
      if (note) {
        try {
          await deps.telegram.notifyOwner(note);
        } catch (error) {
          // Уведомление необязательное — состояние уже корректно без него.
          console.error('daily: не удалось отправить уведомление о пустом бакете', error);
        }
      }
    }
  }

  // 3. Ждать нажатий примерно options.listenMinutes. getUpdates уже держит
  // соединение открытым до 30с сама (см. комментарий у Telegram.getUpdates
  // в ../telegram/api.ts) — отдельный sleep между вызовами не нужен и
  // только тратил бы время стены сверх long-poll. Выходим раньше срока,
  // если разбирать больше нечего.
  const until = deps.now().getTime() + options.listenMinutes * 60_000;
  while (state.pending.length > 0 && deps.now().getTime() < until) {
    const updates = await deps.telegram.getUpdates(state.lastUpdateId + 1);
    if (updates.length === 0) continue;
    await handleUpdates(updates, state, approveDeps, deps.now());
    await deps.persistState(state);
  }
  // Всё, что осталось в state.pending, — карточки у владельца с живыми
  // кнопками; состояние уже сохранено. Следующий прогон разберёт нажатие
  // на этих карточках через дренаж backlog на шаге 1.
}
