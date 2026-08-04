import type { BucketId, Candidate } from '../bandcamp/types.ts';
import { canonicalizeTag } from '../lib/tags.ts';
import { BUCKETS } from '../profile/buckets.ts';
import type { InlineKeyboard, TelegramUpdate } from './api.ts';
import { TelegramApiError } from './api.ts';
import { buildCard, buildChannelPost, parseCallback } from './card.ts';

export interface PendingCard {
  bucket: BucketId;
  messageId: number;
  /**
   * Зафиксировано в момент отправки карточки владельцу и НЕ меняется при
   * подмене кандидата кнопкой «другой». Telegram не даёт превратить
   * фото-сообщение (отправленное `sendPhoto`) в текстовое или наоборот при
   * редактировании — весь жизненный цикл сообщения нужно редактировать
   * одним и тем же методом (`editMessageCaption` для фото, `editMessageText`
   * для текста), независимо от того, есть ли обложка у ТЕКУЩЕГО кандидата,
   * который сейчас показан в карточке.
   */
  hasPhoto: boolean;
  candidate: Candidate;
  matchedTags: string[];
  /** Запас на случай нажатия «другой кандидат». */
  alternatives: Candidate[];
}

export interface PostedEntry {
  itemId: number;
  bucket: BucketId;
  url: string;
  title: string;
  artist: string;
  postedAt: string;
}

export interface ApproveState {
  pending: PendingCard[];
  posted: PostedEntry[];
  /** Тег (как он лежит в Candidate.tags — нижний регистр, сырое написание) → сколько раз владелец скипнул релиз с этим тегом. */
  feedbackTags: Record<string, number>;
  /**
   * URL релизов, уже показанных владельцу (в любом статусе — опубликован,
   * скипнут, заменён). Ключ — URL, а НЕ itemId (см. "Решения, принятые по
   * ходу реализации" в плане, п.1): релиз, найденный через дискографию
   * подписки, несёт вместо настоящего item_id детерминированный хеш URL
   * (см. `hashUrl` в `src/pipeline/fresh.ts`); тот же самый релиз, увиденный
   * позже через Discover или в коллекции соседа, придёт с другим, настоящим
   * числовым id — по itemId это были бы два разных релиза, по URL один и
   * тот же. itemId остаётся только компактной ручкой для callback_data.
   */
  seen: string[];
  lastUpdateId: number;
}

/** Итоговое содержимое отредактированного сообщения — то, что уходит в editMessageCaption/editMessageText. */
export interface CardEdit {
  messageId: number;
  hasPhoto: boolean;
  caption: string;
  keyboard: InlineKeyboard;
}

export interface ApproveDeps {
  /**
   * Публикация в канал бакета. Может бросить `TelegramApiError` (см.
   * `src/telegram/api.ts`) — обработка ошибки (recoverable vs
   * misconfiguration) целиком на стороне `handleUpdates`, эта функция
   * просто честно пробрасывает исключение.
   */
  postToChannel: (bucket: BucketId, text: string) => Promise<void>;
  /** Подменяет содержимое карточки владельца на нового кандидата — кнопки остаются активными. */
  replaceCard: (edit: CardEdit) => Promise<void>;
  /** Финализирует карточку владельца (публикация/скип/кандидаты кончились) — кнопки снимаются. */
  closeCard: (edit: CardEdit) => Promise<void>;
  ack: (callbackQueryId: string, text?: string) => Promise<void>;
}

/** Лимит Telegram на подпись/текст сообщения — тот же, что и в card.ts. */
const CAPTION_LIMIT = 1024;

const CLEARED_KEYBOARD: InlineKeyboard = { inline_keyboard: [] };
const EMPTY_TAG_SET: ReadonlySet<string> = new Set();

/**
 * Опорные теги каждого бакета, в каноническом виде, посчитанные один раз
 * при загрузке модуля — используются только для того, чтобы ИСКЛЮЧИТЬ их
 * из анти-фидбек штрафа при скипе (см. `handleSkip`). Каждый релиз бакета
 * несёт опорный тег своего бакета по построению (это и есть критерий
 * `bucketsOf` в `../profile/buckets.ts`), так что без исключения любой скип
 * в бакете штрафовал бы именно этот вездесущий тег — а не то, что владельцу
 * реально не понравилось.
 */
const SEED_TAGS_BY_BUCKET = new Map<BucketId, ReadonlySet<string>>(
  BUCKETS.map((bucket) => [bucket.id, new Set(bucket.seedTags.map(canonicalizeTag))]),
);

function remember(state: ApproveState, url: string): void {
  if (!state.seen.includes(url)) state.seen.push(url);
}

/**
 * Собирает `CardEdit` из текущего содержимого карточки. `note`, если задан,
 * дописывается под обычной подписью и снимает клавиатуру — это финализация
 * (опубликовано/скип/кандидаты кончились). Без `note` клавиатура остаётся
 * живой — карточка просто подменяет кандидата (`next`).
 *
 * Подпись урезается до `CAPTION_LIMIT` простым `slice` уже ПОСЛЕ того, как
 * `buildCard` аккуратно (с учётом суррогатных пар и HTML-сущностей, см.
 * `card.ts`) подогнала её под лимит сама по себе. Разрезать по живому ещё
 * раз здесь без такой же аккуратности в принципе может отрезать сущность
 * или суррогатную пару пополам — но это осознанно допустимый риск: если
 * `note` вытолкнула итог за границу и Telegram отклонит именно этот вызов
 * `editMessage*`, `closeCard` в `handleUpdates` вызывается best-effort (см.
 * `safely`) — состояние (posted/pending) к этому моменту уже записано
 * корректно, косметическая правка подписи не является источником истины.
 * Такой случай в принципе редкий: он требует, чтобы исходная подпись без
 * `note` уже стояла впритык к лимиту (адверсариальные заголовки в 900
 * символов и т.п.), а не обычного релиза с Bandcamp.
 */
function cardEditFor(card: PendingCard, note?: string): CardEdit {
  const built = buildCard(card.candidate, card.bucket, card.matchedTags);
  const caption = note ? `${built.caption}\n\n${note}`.slice(0, CAPTION_LIMIT) : built.caption;
  return {
    messageId: card.messageId,
    hasPhoto: card.hasPhoto,
    caption,
    keyboard: note ? CLEARED_KEYBOARD : built.keyboard,
  };
}

/** Выполняет косметический побочный вызов, проглатывая ошибку — используется там, где состояние уже корректно записано и от результата этого вызова не зависит. */
async function safely(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.error('approve: побочный вызов провалился, но состояние уже сохранено корректно', error);
  }
}

async function safeAck(deps: ApproveDeps, callbackQueryId: string, text?: string): Promise<void> {
  try {
    await deps.ack(callbackQueryId, text);
  } catch (error) {
    console.error('approve: не удалось подтвердить callback_query', error);
  }
}

/**
 * Нажатие «В канал». Три случая:
 *
 * 1. URL уже есть в `state.posted` — карточка зависла в `pending`, хотя
 *    релиз реально ушёл в канал раньше (обычно след того, что предыдущий
 *    прогон упал между реальной публикацией и сохранением состояния — см.
 *    комментарий у "Идемпотентность" в задаче). Публикацию НЕ повторяем,
 *    только приводим состояние в порядок.
 * 2. `postToChannel` бросает — публикации не было. Состояние не трогаем
 *    вообще: карточка остаётся в `pending` с живыми кнопками, `posted` не
 *    пополняется. Именно поэтому повторная обработка того же нажатия (или
 *    осознанный повторный клик владельца) не может опубликовать дважды —
 *    сравнивать не с чем, если состояние ни разу не записало факт публикации.
 * 3. Успех — состояние (posted + удаление из pending) записывается СРАЗУ,
 *    синхронно, до следующего `await` (закрытие карточки у владельца).
 *    Если та правка провалится, posted/pending уже согласованы и не
 *    допустят повторной публикации.
 */
async function handlePost(
  state: ApproveState,
  deps: ApproveDeps,
  card: PendingCard,
  index: number,
  callbackQueryId: string,
  now: Date,
): Promise<void> {
  const alreadyPosted = state.posted.some((entry) => entry.url === card.candidate.url);
  if (alreadyPosted) {
    remember(state, card.candidate.url);
    state.pending.splice(index, 1);
    await safely(() => deps.closeCard(cardEditFor(card, '📢 уже было опубликовано ранее')));
    await safeAck(deps, callbackQueryId, 'уже опубликовано ранее');
    return;
  }

  try {
    await deps.postToChannel(card.bucket, buildChannelPost(card.candidate));
  } catch (error) {
    // recoverable (429/5xx) — временный сбой, стоит просто попробовать ещё
    // раз; всё остальное (400/401/403/404 и т.п. или вовсе не TelegramApiError)
    // трактуем как misconfiguration — повтор без вмешательства владельца
    // не поможет (неверный токен, бот не админ в канале, битый chat_id).
    const recoverable = error instanceof TelegramApiError && error.recoverable;
    const detail = error instanceof Error ? error.message : String(error);
    const message = recoverable
      ? `не получилось опубликовать — Telegram сейчас недоступен, попробуйте ещё раз (${detail})`
      : `не получилось опубликовать — похоже, неправильно настроен канал (chat_id/права бота), проверьте настройки и нажмите ещё раз (${detail})`;
    await safeAck(deps, callbackQueryId, message);
    return;
  }

  state.posted.push({
    itemId: card.candidate.itemId,
    bucket: card.bucket,
    url: card.candidate.url,
    title: card.candidate.title,
    artist: card.candidate.artist,
    postedAt: now.toISOString().slice(0, 10),
  });
  state.pending.splice(index, 1);
  remember(state, card.candidate.url);

  await safely(() => deps.closeCard(cardEditFor(card, '📢 опубликовано')));
  await safeAck(deps, callbackQueryId, 'опубликовано');
}

async function handleSkip(
  state: ApproveState,
  deps: ApproveDeps,
  card: PendingCard,
  index: number,
  callbackQueryId: string,
): Promise<void> {
  const seedTags = SEED_TAGS_BY_BUCKET.get(card.bucket) ?? EMPTY_TAG_SET;
  for (const tag of card.candidate.tags) {
    if (seedTags.has(canonicalizeTag(tag))) continue;
    state.feedbackTags[tag] = (state.feedbackTags[tag] ?? 0) + 1;
  }
  remember(state, card.candidate.url);
  state.pending.splice(index, 1);
  await safely(() => deps.closeCard(cardEditFor(card, '⏭ скип')));
  await safeAck(deps, callbackQueryId, 'скип');
}

async function handleNext(
  state: ApproveState,
  deps: ApproveDeps,
  card: PendingCard,
  index: number,
  callbackQueryId: string,
): Promise<void> {
  remember(state, card.candidate.url);
  const replacement = card.alternatives[0];
  if (!replacement) {
    state.pending.splice(index, 1);
    await safely(() => deps.closeCard(cardEditFor(card, 'кандидаты кончились')));
    await safeAck(deps, callbackQueryId, 'кандидаты кончились');
    return;
  }

  // Карточку у Telegram подменяем ДО того, как мутировать состояние: если
  // editMessage* провалится, state.pending останется в точности тем, что
  // владелец реально видит в чате (старый кандидат, тот же запас
  // альтернатив) — повторное «другой» просто попробует снова, вместо того
  // чтобы потерять альтернативу или разойтись с тем, что показано на экране.
  await deps.replaceCard(cardEditFor({ ...card, candidate: replacement }));
  card.alternatives.shift();
  card.candidate = replacement;
  await safeAck(deps, callbackQueryId, 'следующий');
}

/**
 * Обрабатывает накопившиеся нажатия. Состояние меняется на месте —
 * вызывающий код (ежедневный джоб) сохраняет его в файлы после разбора
 * всей пачки. Сеть и файлы эта функция не трогает вообще — все побочные
 * эффекты идут через `deps`.
 */
export async function handleUpdates(
  updates: TelegramUpdate[],
  state: ApproveState,
  deps: ApproveDeps,
  now: Date = new Date(),
): Promise<void> {
  for (const update of updates) {
    // Обновление считается "увиденным" независимо от того, как прошла его
    // обработка (успех, ошибка, неизвестная карточка) — иначе Telegram
    // будет бесконечно передоставлять ровно этот update_id на каждом
    // следующем getUpdates. Это НЕ означает "действие выполнено": за это
    // отвечают posted/pending, которые ниже правятся только при реальном
    // успехе.
    state.lastUpdateId = Math.max(state.lastUpdateId, update.update_id);
    const query = update.callback_query;
    if (!query?.data) continue;

    const parsed = parseCallback(query.data);
    if (!parsed) {
      await safeAck(deps, query.id);
      continue;
    }

    const index = state.pending.findIndex(
      (entry) => entry.candidate.itemId === parsed.itemId && entry.bucket === parsed.bucket,
    );
    if (index === -1) {
      await safeAck(deps, query.id, 'карточка уже обработана');
      continue;
    }
    const card = state.pending[index]!;

    try {
      if (parsed.action === 'post') {
        await handlePost(state, deps, card, index, query.id, now);
      } else if (parsed.action === 'skip') {
        await handleSkip(state, deps, card, index, query.id);
      } else {
        await handleNext(state, deps, card, index, query.id);
      }
    } catch (error) {
      // Один сбойный апдейт (например, Telegram отвалился прямо на
      // редактировании карточки у "next") не должен ронять всю пачку —
      // остальные нажатия в этом же батче обязаны быть разобраны, а offset
      // сохранит вызывающий код уже после возврата из этой функции.
      console.error('approve: не удалось обработать нажатие', parsed, error);
      await safeAck(deps, query.id, 'что-то пошло не так, попробуйте ещё раз');
    }
  }
}
