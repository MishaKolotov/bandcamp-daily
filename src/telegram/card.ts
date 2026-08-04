import type { BucketId, Candidate } from '../bandcamp/types.ts';
import { BUCKETS } from '../profile/buckets.ts';
import type { InlineKeyboard } from './api.ts';

/** Лимит Telegram на подпись фото/сообщения — 1024 юнита UTF-16. */
const CAPTION_LIMIT = 1024;

export type CardAction = 'post' | 'skip' | 'next';

export interface Card {
  photo: string | null;
  caption: string;
  keyboard: InlineKeyboard;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const [year, month, day] = iso.split('-');
  return `${day}.${month}.${year}`;
}

function channelTitleOf(bucket: BucketId): string | undefined {
  return BUCKETS.find((b) => b.id === bucket)?.channelTitle;
}

/**
 * callback_data ограничен Telegram 64 байтами. Всё в нём — ASCII (action,
 * id бакета, десятичный itemId), так что байты и символы здесь совпадают.
 * Худший случай — самый длинный action ('post'/'skip'/'next' — все по 4
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
const MAX_ACTION_LENGTH = Math.max('post'.length, 'skip'.length, 'next'.length);
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
  if (action !== 'post' && action !== 'skip' && action !== 'next') return null;
  const parsed = Number(itemId);
  if (!Number.isFinite(parsed)) return null;
  return { action, bucket: bucket as BucketId, itemId: parsed };
}

/**
 * Короткое объяснение, почему кандидат вообще показан. Только для владельца
 * — подписчикам канала эти внутренности рекомендателя ничего не говорят
 * (обзор ниже, в body()). Теги, из-за которых сработал бакет, здесь больше
 * не перечисляются: их и так видно в строке тегов на строку выше, а читать
 * один и тот же список дважды в каждой карточке незачем.
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
  /**
   * Объяснение ("свежее от ..." / "откопано у соседей...") — только для
   * карточки владельца. Подписчикам канала это внутренняя кухня
   * рекомендателя, а не информация о релизе; пост в канал его не получает.
   */
  includeExplanation: boolean;
  /**
   * Название канала — только для карточки владельца: он одновременно
   * разбирает кандидатов сразу из четырёх каналов в одном чате с ботом, и
   * без подписи не всегда понятно, куда уйдёт кнопка "В канал". В самом
   * посте в канал название канала не нужно — подписчики и так знают, где
   * они подписаны, дублировать это в тексте поста незачем.
   */
  channelTitle?: string;
}

/**
 * Артист + название и ссылка на релиз — обязательная часть текста: без
 * первого нельзя опознать релиз, без второй пост не выполняет свою функцию
 * (нечего слушать/публиковать). Название канала (если есть) — тоже
 * обязательная часть: она короткая и без неё владелец не поймёт, какую из
 * четырёх кнопок "В канал" он нажимает. Теги, лейбл и объяснение —
 * вспомогательные, они первыми уходят, если огромный заголовок съедает весь
 * лимит подписи. Ссылка никогда не обрезается: обрезанный URL — не ссылка,
 * а мусор, и никогда не выводится сырой: `candidate.url` не гарантированно
 * свободен от `&` (Discover его обрезает от query-параметров, а коллекция
 * фаната — нет), а необработанный `&` в HTML-подписи роняет всё сообщение
 * целиком в Telegram. Экранирование не портит саму ссылку: Telegram
 * декодирует сущности перед автолинковкой.
 */
function body(candidate: Candidate, options: BodyOptions): string {
  const urlLine = escapeHtml(candidate.url);
  const channelLine = options.channelTitle ? escapeHtml(options.channelTitle) : '';
  const channelReserve = channelLine ? channelLine.length + 1 : 0;
  const headerBudget = CAPTION_LIMIT - urlLine.length - 1 - channelReserve;
  const header = buildHeader(candidate.artist, candidate.title, headerBudget);

  const optional = [
    candidate.tags.length > 0 ? escapeHtml(candidate.tags.slice(0, 8).join(' · ')) : '',
    options.includeExplanation ? why(candidate) : '',
    candidate.label ? `лейбл: ${escapeHtml(candidate.label)}` : '',
  ].filter(Boolean);

  const lines = channelLine ? [channelLine, header] : [header];
  let used = channelReserve + header.length + 1 + urlLine.length;
  for (const line of optional) {
    if (used + line.length + 1 <= CAPTION_LIMIT) {
      lines.push(line);
      used += line.length + 1;
    }
  }
  lines.push(urlLine);
  return lines.join('\n');
}

/**
 * matchedTags принимается ради стабильности публичного контракта (вызывающий
 * код в pipeline уже вычисляет его для скоринга и передаёт сюда), но больше
 * не попадает в текст карточки: раньше explanation-строка повторяла до трёх
 * из тех же тегов, что уже перечислены строкой выше, — владелец читал одни
 * и те же слова дважды на каждой из шести карточек в день.
 */
export function buildCard(candidate: Candidate, bucket: BucketId, matchedTags: string[]): Card {
  void matchedTags;
  return {
    photo: candidate.artUrl,
    caption: body(candidate, { includeExplanation: true, channelTitle: channelTitleOf(bucket) }),
    keyboard: {
      inline_keyboard: [
        [
          { text: '📢 В канал', callback_data: buildCallback('post', bucket, candidate.itemId) },
          { text: '⏭ Скип', callback_data: buildCallback('skip', bucket, candidate.itemId) },
          { text: '🔄 Другой', callback_data: buildCallback('next', bucket, candidate.itemId) },
        ],
      ],
    },
  };
}

export function buildChannelPost(candidate: Candidate): string {
  return body(candidate, { includeExplanation: false });
}
