import type { BucketId, Candidate } from '../bandcamp/types.ts';
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

/**
 * callback_data ограничен Telegram 64 байтами. Всё в нём — ASCII (action,
 * id бакета, десятичный itemId), так что байты и символы здесь совпадают.
 * Худший случай: самый длинный action ('post'/'skip'/'next' — все по 4
 * символа), самый длинный id бакета ('hardcore-punk', 13 символов) и
 * максимально возможный itemId. itemId — настоящий числовой id Bandcamp для
 * большинства релизов, но для релизов, найденных через дискографию
 * подписки (у страницы /music числового id нет), это cyrb53-хеш URL (см.
 * hashUrl в src/pipeline/fresh.ts), который может занимать весь диапазон
 * безопасных целых JS — вплоть до Number.MAX_SAFE_INTEGER
 * (9007199254740991, 16 цифр). Итого худший случай: 4 + 1 + 13 + 1 + 16 =
 * 35 байт — заметно меньше лимита в 64. Тест ниже фиксирует эту гарантию,
 * чтобы будущая правка схемы id не сломала её незаметно.
 */
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

function why(candidate: Candidate, matchedTags: string[]): string {
  if (candidate.origin === 'archive') {
    const percent = Math.round((candidate.neighborWeight ?? 0) * 100);
    return `откопано у соседей по вкусу${percent > 0 ? ` (близость ${percent}%)` : ''}`;
  }
  const date = formatDate(candidate.releasedAt);
  // matchedTags приходят из candidate.tags — свободного текста Bandcamp, может
  // содержать <, >, & — экранируем, иначе эта строка ломает HTML подписи.
  const tags = matchedTags.slice(0, 3).map(escapeHtml).join(', ');
  return `свежее${date ? ` от ${date}` : ''}${tags ? ` · совпало: ${tags}` : ''}`;
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

/**
 * Артист + название и ссылка на релиз — обязательная часть текста: без
 * первого нельзя опознать релиз, без второй пост не выполняет свою функцию
 * (нечего слушать/публиковать). Теги, лейбл и объяснение — вспомогательные,
 * они первыми уходят, если огромный заголовок съедает весь лимит подписи.
 * Ссылка никогда не обрезается: обрезанный URL — не ссылка, а мусор.
 */
function body(candidate: Candidate, matchedTags: string[]): string {
  const urlLine = candidate.url;
  const headerBudget = CAPTION_LIMIT - urlLine.length - 1; // -1 на перевод строки перед ссылкой
  const header = buildHeader(candidate.artist, candidate.title, headerBudget);

  const optional = [
    candidate.tags.length > 0 ? escapeHtml(candidate.tags.slice(0, 8).join(' · ')) : '',
    why(candidate, matchedTags),
    candidate.label ? `лейбл: ${escapeHtml(candidate.label)}` : '',
  ].filter(Boolean);

  const lines = [header];
  let used = header.length + 1 + urlLine.length;
  for (const line of optional) {
    if (used + line.length + 1 <= CAPTION_LIMIT) {
      lines.push(line);
      used += line.length + 1;
    }
  }
  lines.push(urlLine);
  return lines.join('\n');
}

export function buildCard(candidate: Candidate, bucket: BucketId, matchedTags: string[]): Card {
  return {
    photo: candidate.artUrl,
    caption: body(candidate, matchedTags),
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

export function buildChannelPost(candidate: Candidate, matchedTags: string[]): string {
  return body(candidate, matchedTags);
}
