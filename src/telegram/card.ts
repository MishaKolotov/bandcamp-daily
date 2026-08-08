import type { BucketId, Candidate } from '../bandcamp/types.ts';
import { BUCKETS } from '../profile/buckets.ts';
import type { InlineKeyboard } from './api.ts';

/** Лимит Telegram на подпись фото/сообщения — 1024 юнита UTF-16. */
const CAPTION_LIMIT = 1024;

export type CardAction = 'skip' | 'next';

export interface Card {
  photo: string | null;
  caption: string;
  keyboard: InlineKeyboard;
}

/**
 * Экранирует текст для HTML-подписи Telegram: `&`/`<`/`>` обязательны —
 * необработанный спецсимвол роняет всё сообщение как невалидный HTML.
 * Кавычка `"` экранируется тоже, хотя сейчас в файле нет ни одного
 * HTML-атрибута, куда значение могло бы подставляться (`href="..."` ушёл
 * вместе с `buildChannelPost` — ссылка на релиз теперь всегда голая
 * хвостовая строка, см. `body()`): `&quot;` в текстовом содержимом —
 * валидная и безвредная сущность, так что экранировать её здесь безусловно
 * дешевле, чем держать в голове инвариант "эта функция используется только
 * вне атрибутов" и однажды тихо его сломать.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const [year, month, day] = iso.split('-');
  return `${day}.${month}.${year}`;
}

function bucketTitleOf(bucket: BucketId): string | undefined {
  return BUCKETS.find((b) => b.id === bucket)?.title;
}

/**
 * callback_data ограничен Telegram 64 байтами. Всё в нём — ASCII (action,
 * id бакета, десятичный itemId), так что байты и символы здесь совпадают.
 * Худший случай — самый длинный action ('skip'/'next' — оба по 4
 * символа), самый длинный id среди РЕАЛЬНЫХ бакетов из `BUCKETS` (а не
 * захардкоженное предположение вроде "'hardcore-punk', 13 символов" — тот
 * список уже расширялся один раз добавлением 'black-metal', и это не
 * последний раз) и максимально возможный itemId. itemId — настоящий
 * числовой id Bandcamp для большинства свежих релизов, но для релизов,
 * найденных через дискографию подписки (у страницы /music числового id нет),
 * и для всех архивных кандидатов (см. `archiveCandidates` в
 * src/pipeline/archive.ts — itemId соседского релиза не хранится в
 * data/neighbors.json) — это cyrb53-хеш URL (см. hashUrl в src/lib/hash.ts),
 * который может занимать весь диапазон безопасных целых JS — вплоть до
 * Number.MAX_SAFE_INTEGER (9007199254740991, 16 цифр).
 *
 * Инвариант проверяется здесь же, при загрузке модуля: если однажды
 * появится бакет с id длиннее нынешнего максимума настолько, что это
 * перестанет укладываться в 64 байта, приложение упадёт сразу с понятной
 * ошибкой — вместо того чтобы молча слать Telegram callback_data, который
 * он отвергнет.
 */
const MAX_ACTION_LENGTH = Math.max('skip'.length, 'next'.length);
const MAX_BUCKET_ID_LENGTH = Math.max(...BUCKETS.map((b) => b.id.length));
const MAX_ITEM_ID_DIGITS = String(Number.MAX_SAFE_INTEGER).length;
const WORST_CASE_CALLBACK_BYTES =
  MAX_ACTION_LENGTH + 1 + MAX_BUCKET_ID_LENGTH + 1 + MAX_ITEM_ID_DIGITS;
if (WORST_CASE_CALLBACK_BYTES > 64) {
  throw new Error(
    `callback_data в худшем случае занимает ${WORST_CASE_CALLBACK_BYTES} байт — больше лимита ` +
      "Telegram в 64. Проверьте id бакетов в src/profile/buckets.ts: один из них слишком длинный.",
  );
}

export function buildCallback(action: CardAction, bucket: BucketId, itemId: number): string {
  return `${action}|${bucket}|${itemId}`;
}

export function parseCallback(
  data: string,
): { action: CardAction; bucket: BucketId; itemId: number } | null {
  const [action, bucket, itemId] = data.split('|');
  if (!action || !bucket || !itemId) return null;
  if (action !== 'skip' && action !== 'next') return null;
  const parsed = Number(itemId);
  if (!Number.isFinite(parsed)) return null;
  return { action, bucket: bucket as BucketId, itemId: parsed };
}

/**
 * Короткое объяснение, почему кандидат вообще показан. Теги, из-за которых
 * сработал бакет, здесь больше не перечисляются: их и так видно в строке
 * тегов на строку выше, а читать один и тот же список дважды в каждой
 * карточке незачем.
 */
function why(candidate: Candidate): string {
  if (candidate.origin === 'archive') {
    const percent = Math.round((candidate.neighborWeight ?? 0) * 100);
    return `откопано у соседей по вкусу${percent > 0 ? ` (близость ${percent}%)` : ''}`;
  }
  const date = formatDate(candidate.releasedAt);
  return date ? `свежее от ${date}` : 'свежее';
}

/** Обрезает сырой (неэкранированный) текст, не разрывая суррогатную пару. */
function truncatePlain(text: string, maxLen: number): string {
  if (maxLen <= 0) return '';
  if (text.length <= maxLen) return text;
  let end = maxLen - 1; // место под многоточие
  if (end > 0 && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) {
    end -= 1;
  }
  return `${text.slice(0, Math.max(end, 0))}…`;
}

/**
 * Обрезает сырой текст и экранирует его так, что результат гарантированно
 * укладывается в `budget` символов HTML.
 *
 * Экранирование выполняется ПОСЛЕ обрезки сырого текста, а не наоборот —
 * поэтому сущности (&amp;/&lt;/&gt;) никогда не режутся пополам: мы обрезаем
 * чистый текст, а затем целиком превращаем спецсимволы в целые сущности. Но
 * экранирование раздувает текст (например, хвост из одних '<' — каждый
 * символ после экранирования занимает 4 места вместо одного), поэтому
 * обрезка по бюджету СЫРЫХ символов не гарантирует, что ЭКРАНИРОВАННЫЙ
 * результат в него влезет. Единственный надёжный способ — переспросить
 * после экранирования и, если результат всё ещё длиннее бюджета, укоротить
 * сырой текст ещё на символ и повторить. Худший случай — O(n) итераций по
 * длине текста (не больше 1024 для длины подписи), не проблема для строки
 * форматирования, вызываемой один раз на кандидата.
 */
function fitEscaped(text: string, budget: number): string {
  const safeBudget = Math.max(budget, 0);
  let plainLen = Math.min(text.length, safeBudget);
  let html = escapeHtml(truncatePlain(text, plainLen));
  while (html.length > safeBudget && plainLen > 0) {
    plainLen -= 1;
    html = escapeHtml(truncatePlain(text, plainLen));
  }
  return html;
}

/**
 * Собирает жирный заголовок «<b>артист</b> — название», подгоняя его под
 * `budget` символов итогового HTML. Тег <b>...</b> добавляется программно
 * вокруг уже готового (обрезанного и экранированного) содержимого, так что
 * его невозможно разорвать — обрезке подвергается только то, что внутри.
 */
function buildHeader(artist: string, title: string, budget: number): string {
  const safeBudget = Math.max(budget, 0);
  const prefix = `<b>${escapeHtml(artist)}</b> — `;
  if (prefix.length > safeBudget) {
    // Экстремальный случай: даже одному имени артиста не хватает места.
    // Та же процедура «обрезать → экранировать → перепроверить», что и для
    // названия — иначе раздутие от экранирования могло бы протолкнуть
    // результат обратно за пределы бюджета.
    const artistBudget = Math.max(safeBudget - '<b></b>'.length, 0);
    return `<b>${fitEscaped(artist, artistBudget)}</b>`;
  }
  const remaining = safeBudget - prefix.length;
  return `${prefix}${fitEscaped(title, remaining)}`;
}

interface BodyOptions {
  /** Объяснение ("свежее от ..." / "откопано у соседей..."), почему кандидат вообще показан. */
  includeExplanation: boolean;
  /**
   * Человекочитаемое имя жанра. Владелец получает один альбом за заход из
   * любого из четырёх бакетов, и без подписи не видно, из какого именно —
   * а это ровно тот контекст, по которому он решает, слушать сейчас или
   * позже.
   */
  bucketTitle?: string;
  /**
   * Строка "лейбл: ...". `score()` в `../profile/score.ts` сам взвешивает
   * репутацию лейбла как часть скоринга (`labelBonus`) — тот же сигнал,
   * который помогает рекомендателю ранжировать кандидата, помогает и
   * владельцу его вручную оценить, поэтому карточка его показывает.
   */
  includeLabel: boolean;
}

/**
 * Артист + название и ссылка на релиз — обязательная часть текста: без
 * первого нельзя опознать релиз, без второй нечего слушать. Название бакета
 * (если есть) — тоже обязательная часть: она короткая и без неё владелец не
 * поймёт, из какого из четырёх бакетов пришёл конкретный кандидат. Теги,
 * лейбл и объяснение — вспомогательные, они первыми уходят, если огромный
 * заголовок съедает весь лимит подписи.
 *
 * Ссылка — всегда хвостовая строка под заголовком и никогда не обрезается:
 * обрезанный URL — не ссылка, а мусор. И никогда не выводится сырой:
 * `candidate.url` не гарантированно свободен от `&` (Discover его обрезает
 * от query-параметров, а коллекция фаната — нет), а необработанный
 * спецсимвол в HTML-подписи роняет всё сообщение целиком в Telegram.
 * Экранирование не портит саму ссылку: Telegram декодирует сущности перед
 * тем, как строить из неё автопревью.
 */
function body(candidate: Candidate, options: BodyOptions): string {
  const escapedUrl = escapeHtml(candidate.url);
  const titleLine = options.bucketTitle ? escapeHtml(options.bucketTitle) : '';
  const titleReserve = titleLine ? titleLine.length + 1 : 0;

  const headerBudget = CAPTION_LIMIT - escapedUrl.length - 1 - titleReserve;
  const header = buildHeader(candidate.artist, candidate.title, headerBudget);

  const tagsLine = candidate.tags.length > 0 ? escapeHtml(candidate.tags.slice(0, 8).join(' · ')) : '';

  const optional = [
    tagsLine,
    options.includeExplanation ? why(candidate) : '',
    options.includeLabel && candidate.label ? `лейбл: ${escapeHtml(candidate.label)}` : '',
  ].filter(Boolean);

  const lines = titleLine ? [titleLine, header] : [header];
  let used = titleReserve + header.length + 1 + escapedUrl.length;
  for (const line of optional) {
    if (used + line.length + 1 <= CAPTION_LIMIT) {
      lines.push(line);
      used += line.length + 1;
    }
  }
  lines.push(escapedUrl);
  return lines.join('\n');
}

/**
 * matchedTags принимается ради стабильности публичного контракта (вызывающий
 * код в pipeline уже вычисляет его для скоринга и передаёт сюда), но больше
 * не попадает в текст карточки: раньше explanation-строка повторяла до трёх
 * из тех же тегов, что уже перечислены строкой выше, — владелец читал одни
 * и те же слова дважды в каждой карточке.
 */
export function buildCard(candidate: Candidate, bucket: BucketId, matchedTags: string[]): Card {
  void matchedTags;
  return {
    photo: candidate.artUrl,
    caption: body(candidate, {
      includeExplanation: true,
      bucketTitle: bucketTitleOf(bucket),
      includeLabel: true,
    }),
    keyboard: {
      inline_keyboard: [
        [
          { text: '👎 Не моё', callback_data: buildCallback('skip', bucket, candidate.itemId) },
          { text: '🔄 Другой', callback_data: buildCallback('next', bucket, candidate.itemId) },
        ],
      ],
    },
  };
}
