import type { BucketId, Candidate } from '../bandcamp/types.ts';
import { canonicalizeTag } from '../lib/tags.ts';
import { BUCKETS } from '../profile/buckets.ts';
import type { InlineKeyboard, TelegramUpdate } from './api.ts';
import { buildCard, parseCallback } from './card.ts';

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

export interface ApproveState {
  pending: PendingCard[];
  /** Тег (как он лежит в Candidate.tags — нижний регистр, сырое написание) → сколько раз владелец скипнул релиз с этим тегом. */
  feedbackTags: Record<string, number>;
  /**
   * URL релизов, уже показанных владельцу (в любом статусе — скипнут,
   * заменён кнопкой «другой», просто провисел без ответа). Ключ — URL, а НЕ
   * itemId (см. "Решения, принятые по ходу реализации" в плане, п.1): релиз,
   * найденный через дискографию подписки или пришедший из архивного пула
   * соседей, несёт вместо настоящего item_id детерминированный хеш URL (см.
   * `hashUrl` в `src/lib/hash.ts`); тот же самый релиз, увиденный позже через
   * Discover или в коллекции другого соседа, придёт с другим, настоящим
   * числовым id — по itemId это были бы два разных релиза, по URL один и тот
   * же. itemId остаётся только компактной ручкой для callback_data.
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
  /** Подменяет содержимое карточки владельца на нового кандидата — кнопки остаются активными. */
  replaceCard: (edit: CardEdit) => Promise<void>;
  /**
   * Сносит карточку из лички владельца — вызывается, когда с ней покончено
   * (скип / кандидаты кончились). Раньше карточка на этом месте дожёвывалась
   * в «закрытую» (приписка + снятая клавиатура) и оставалась в чате
   * навсегда; личка зарастала разобранными карточками, а найти в ней то, что
   * ещё надо послушать, становилось нельзя. Теперь в чате остаются только
   * живые карточки.
   *
   * Обратной связью служит всплывашка `ack` — она несёт ровно тот же текст
   * («скип» и т.п.), что раньше дописывался в подпись, и исчезает сама.
   */
  deleteCard: (messageId: number) => Promise<void>;
  ack: (callbackQueryId: string, text?: string) => Promise<void>;
}

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

/**
 * Помечает URL как показанный владельцу — в любом статусе (скипнут, заменён
 * кнопкой «другой», просто провисел сутки без ответа и был снесён
 * подчисткой). Экспортируется ради этого последнего случая: подчистку
 * хвостов делает дневной прогон (`../pipeline/daily.ts`), а решать, что
 * показанное считается показанным, должен один модуль — этот.
 */
export function rememberSeen(state: ApproveState, url: string): void {
  if (!state.seen.includes(url)) state.seen.push(url);
}

/** Собирает `CardEdit` из текущего содержимого карточки — с живой клавиатурой, для подмены кандидата кнопкой «другой». */
function cardEditFor(card: PendingCard): CardEdit {
  const built = buildCard(card.candidate, card.bucket, card.matchedTags);
  return {
    messageId: card.messageId,
    hasPhoto: card.hasPhoto,
    caption: built.caption,
    keyboard: built.keyboard,
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
  rememberSeen(state, card.candidate.url);
  state.pending.splice(index, 1);
  await safely(() => deps.deleteCard(card.messageId));
  await safeAck(deps, callbackQueryId, 'скип');
}

async function handleNext(
  state: ApproveState,
  deps: ApproveDeps,
  card: PendingCard,
  index: number,
  callbackQueryId: string,
): Promise<void> {
  rememberSeen(state, card.candidate.url);
  const replacement = card.alternatives[0];
  if (!replacement) {
    state.pending.splice(index, 1);
    await safely(() => deps.deleteCard(card.messageId));
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
): Promise<void> {
  for (const update of updates) {
    // Обновление считается "увиденным" независимо от того, как прошла его
    // обработка (успех, ошибка, неизвестная карточка) — иначе Telegram
    // будет бесконечно передоставлять ровно этот update_id на каждом
    // следующем getUpdates. Это НЕ означает "действие выполнено": за это
    // отвечает pending, который ниже правится только при реальном успехе.
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
      if (parsed.action === 'skip') {
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
