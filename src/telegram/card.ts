import type { BucketId, Candidate } from '../bandcamp/types.ts';
import { BUCKETS } from '../profile/buckets.ts';
import { canonicalizeTag } from '../lib/tags.ts';
import type { InlineKeyboard } from './api.ts';

/** Лимит Telegram на подпись фото/сообщения — 1024 юнита UTF-16. */
const CAPTION_LIMIT = 1024;

export type CardAction = 'post' | 'skip' | 'next';

export interface Card {
  photo: string | null;
  caption: string;
  keyboard: InlineKeyboard;
}

/**
 * Экранирует текст и для содержимого тега (`&`/`<`/`>`), и для значения
 * HTML-атрибута (добавляет `"`). Раньше эта функция экранировала только
 * тройку `&`/`<`/`>`, потому что использовалась исключительно как текстовое
 * содержимое (`<b>...</b>`, голая строка URL) — там кавычка не является
 * спецсимволом и не нуждается в экранировании. С заголовком-ссылкой
 * (`<a href="...">`, см. `body()`) экранируемое значение теперь ещё и
 * подставляется ВНУТРЬ атрибута `href="..."`, где неэкранированная `"`
 * закрыла бы атрибут раньше времени и позволила бы содержимому URL
 * (`candidate.url` — не полностью доверенные данные, см. комментарий у
 * `body()` про `&` в ссылках из коллекции фаната) вырваться в разметку.
 * Экранировать `"` во ВСЕХ вызовах (а не только там, где значение идёт в
 * атрибут) безопаснее одной функции на два контекста, чем заводить вторую:
 * `&quot;` в текстовом содержимом — валидная и безвредная сущность, а не
 * второе место, которое обязано помнить то же правило.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Хэштеги в посте канала — тема задачи "хозяин попросил менять формат
 * поста": "жанры через # чтобы по каналу можно было найти спокойно".
 * Кап на 5. Обоснование по живым данным профиля (data/profile.json,
 * 2026-08): у hardcore-punk ОДНИХ ТОЛЬКО опорных тегов на весе 0.5 — шесть
 * ('punk', 'hardcore', 'hardcore punk', 'raw punk', 'powerviolence', 'ukhc'),
 * и сверху ещё производные с весом выше — 'post-punk' 1, 'd-beat' 0.9264,
 * 'primative' 0.8748, 'crust' 0.7874, 'garage' 0.6299 и так далее: реальный
 * релиз на пересечении сцен легко несёт 8–12 из них одновременно. Без
 * потолка пост превращается в стену хэштегов, которая уже не читается и не
 * ищется лучше плоского списка, который хозяин как раз просил заменить. 5
 * оставляет место для типичного сильного пересечения (опорный тег бакета +
 * пара характерных производных + один-два соседних, как в примере ниже, где
 * из восьми исходных тегов до фильтра доживают всего три) и обрубает
 * длинный хвост слабых совпадений, не трогая частый случай.
 *
 * Именно из-за этого хвоста фильтр — не "показать все теги релиза", а
 * "показать только то, что бакет-профиль реально взвесил" (см. `buildProfile`
 * в `../profile/build.ts`): профиль по построению НЕ содержит теги мест
 * (`locationVocabulary` в `BuildOptions` вычитает их из весов бакета
 * структурно, не статистически) и не содержит тегов, которые ни разу не
 * оказались статистически характерны для бакета хозяина — так голое имя
 * города ('olympia') или вкусовые/маркетинговые слова с релиза-примера в
 * задаче ('energy', 'friendship', 'greatest label of all time', сам тег
 * лейбла 'iron lung') отсекаются без отдельного списка стоп-слов: их просто
 * нет среди ключей `bucketTags`, потому что эти веса ставит `buildProfile`,
 * а не эта функция.
 */
const HASHTAG_CAP = 5;

/**
 * Канонический тег (уже без пробелов/дефисов, см. `canonicalizeTag` в
 * `../lib/tags.ts`) → безопасный для хэштега Telegram текст: только
 * юникодные буквы и цифры, без разделителей, точек, амперсандов, скобок и
 * прочей пунктуации ('r&b' → 'rb'). `canonicalizeTag` вырезает ТОЛЬКО
 * пробел/дефис осознанно (см. её собственный комментарий — 'r&b' должен
 * остаться отдельным тегом при СРАВНЕНИИ, амперсанд там не мусор), но для
 * ПОКАЗА хэштегом остаётся именно мусор: `#r&b` Telegram оборвёт на
 * амперсанде, показав нерабочий обрубок `#r` посреди текста. Эта функция —
 * не вторая версия правила сравнения, а отдельный шаг форматирования поверх
 * него, применяется только к тегам, уже прошедшим фильтр по весу бакета.
 */
function toHashtagText(canonicalTag: string): string {
  return canonicalTag.replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Строка хэштегов для поста в канал: сырые теги кандидата → канонический
 * ключ → вес из `bucketTags` (веса текущего бакета, `BucketProfile.tags` из
 * `../profile/build.ts` — берётся отдельным узким аргументом, а не целым
 * `BucketProfile`, по тем же причинам, что и `seedTags`/`hardRejectTags` у
 * `score()` в `../profile/score.ts`: это единственное, что здесь нужно, и
 * передавать больше — лишняя связанность). Тег без веса в профиле (включая
 * места — `buildProfile` их туда вообще не кладёт) в хэштеги не попадает.
 *
 * Сравнение и дедуп написаний бакета — по каноническому ключу, тем же
 * способом, что и в `score()`: если профиль руками правлен так, что в нём
 * оказалось два написания одного тега, побеждает большее значение, а не
 * сумма (это по-прежнему один тег).
 *
 * Порядок — по весу убывания (сильнее совпадение первым), кап — `HASHTAG_CAP`
 * (см. её комментарий). Если после фильтра, вычищения пунктуации и обрезки
 * digit-first тегов (Telegram не считает хэштегом токен, начинающийся с
 * цифры — задача явно требует это отсеивать, а не пытаться чинить префиксом)
 * ничего не осталось — пустая строка, и `body()` ниже её не напечатает (та
 * же логика, что уже отбрасывает пустые опциональные строки).
 */
function buildHashtags(candidateTags: string[], bucketTags: Record<string, number>): string {
  const weightByCanonicalTag = new Map<string, number>();
  for (const [tag, weight] of Object.entries(bucketTags)) {
    const key = canonicalizeTag(tag);
    const existing = weightByCanonicalTag.get(key);
    if (existing === undefined || weight > existing) weightByCanonicalTag.set(key, weight);
  }

  const seenHashtags = new Set<string>();
  const matched: Array<{ hashtag: string; weight: number }> = [];
  for (const raw of candidateTags) {
    const canonical = canonicalizeTag(raw);
    const weight = weightByCanonicalTag.get(canonical) ?? 0;
    if (weight <= 0) continue;
    const hashtag = toHashtagText(canonical);
    if (!hashtag || /^[0-9]/.test(hashtag) || seenHashtags.has(hashtag)) continue;
    seenHashtags.add(hashtag);
    matched.push({ hashtag, weight });
  }
  matched.sort((a, b) => b.weight - a.weight);
  return matched
    .slice(0, HASHTAG_CAP)
    .map((entry) => `#${entry.hashtag}`)
    .join(' ');
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
  /**
   * Заголовок оформляется как `<a href="URL">...</a>` вместо голого
   * `<b>...</b>`, а хвостовая строка с сырым URL не печатается вовсе —
   * ссылка уже целиком лежит в `href`. Только для поста в канал (хозяин
   * попросил ровно это: "добавляй в хедер ссылку в названии"). Карточка
   * владельца заголовок не линкует: она уходит через `sendPhoto` с настоящим
   * вложенным фото (см. `Card.photo`), а не текстовым сообщением с
   * автопревью — там линковать заголовок нечем ловить (никакого link
   * preview на медиа-подписи Telegram не строит), а сырая ссылка отдельной
   * строкой владельцу по-прежнему полезна (скопировать, открыть в браузере
   * напрямую). См. `buildChannelPost` — там же обоснование, что Telegram
   * всё ещё строит большую карточку превью по `href` у `<a>`, а не только
   * по голому автоссылающемуся URL в тексте.
   */
  linkHeader: boolean;
  /**
   * Веса тегов текущего бакета (`BucketProfile.tags` из `../profile/build.ts`,
   * передаётся отдельным узким полем, а не всем `BucketProfile` — см.
   * комментарий у `buildHashtags`). Когда задано, строка тегов рендерится
   * хэштегами через `buildHashtags` (только жанровые теги бакета,
   * отфильтрованные и упорядоченные весом) вместо полного списка через точку.
   * Только для поста в канал: хозяин просил хэштеги именно "чтобы по каналу
   * можно было найти" — карточка владельца читается им самим, а не ищется,
   * и полный сырой список тегов (включая место, вайб-слова с релиза и т.п.)
   * даёт ему больше контекста для решения "постить/скипнуть", чем урезанный
   * жанровый подсписок.
   */
  hashtagBucketTags?: Record<string, number>;
  /**
   * Строка "лейбл: ...". Хозяин прямо сказал, что в посте в канал она не
   * нужна (см. отчёт по задаче) — убрана оттуда безусловно. На карточке
   * владельца остаётся: `score()` в `../profile/score.ts` сам взвешивает
   * репутацию лейбла как часть скоринга (`labelBonus`) — тот же сигнал,
   * который помогает рекомендателю ранжировать кандидата, помогает и
   * владельцу его вручную оценить, поэтому решение здесь — оставить, а не
   * убрать по аналогии с постом в канал.
   */
  includeLabel: boolean;
}

/** `<a href="` + экранированный URL + `">` — построено один раз, чтобы длина открывающего тега (нужна для бюджета заголовка) и сам тег не могли разойтись. */
function anchorOpenTag(escapedUrl: string): string {
  return `<a href="${escapedUrl}">`;
}
const ANCHOR_CLOSE_TAG = '</a>';

/**
 * Артист + название и ссылка на релиз — обязательная часть текста: без
 * первого нельзя опознать релиз, без второй пост не выполняет свою функцию
 * (нечего слушать/публиковать). Название канала (если есть) — тоже
 * обязательная часть: она короткая и без неё владелец не поймёт, какую из
 * четырёх кнопок "В канал" он нажимает. Теги, лейбл и объяснение —
 * вспомогательные, они первыми уходят, если огромный заголовок съедает весь
 * лимит подписи.
 *
 * Ссылка никогда не обрезается — ни как хвостовая строка (`options.linkHeader`
 * false), ни как `href` заголовка (`options.linkHeader` true): обрезанный URL
 * — не ссылка, а мусор. И никогда не выводится сырой: `candidate.url` не
 * гарантированно свободен от `&` (Discover его обрезает от query-параметров,
 * а коллекция фаната — нет) и потенциально не свободен от `"` (см.
 * `escapeHtml` — с появлением `href="..."` кавычка в URL могла бы вырваться
 * из атрибута), а необработанный спецсимвол в HTML-подписи роняет всё
 * сообщение целиком в Telegram. Экранирование не портит саму ссылку:
 * Telegram декодирует сущности перед тем, как строить из неё ссылку/превью.
 */
function body(candidate: Candidate, options: BodyOptions): string {
  const escapedUrl = escapeHtml(candidate.url);
  const channelLine = options.channelTitle ? escapeHtml(options.channelTitle) : '';
  const channelReserve = channelLine ? channelLine.length + 1 : 0;

  // Хвостовая строка с голым URL нужна, только если заголовок сам не несёт
  // ссылку (карточка владельца) — у поста в канал ссылка уже целиком в
  // href заголовка, повторять её отдельной строкой незачем.
  let header: string;
  let trailingUrl: string | null;
  if (options.linkHeader) {
    const openTag = anchorOpenTag(escapedUrl);
    const anchorOverhead = openTag.length + ANCHOR_CLOSE_TAG.length;
    const headerBudget = CAPTION_LIMIT - channelReserve - anchorOverhead;
    header = `${openTag}${buildHeader(candidate.artist, candidate.title, headerBudget)}${ANCHOR_CLOSE_TAG}`;
    trailingUrl = null;
  } else {
    const headerBudget = CAPTION_LIMIT - escapedUrl.length - 1 - channelReserve;
    header = buildHeader(candidate.artist, candidate.title, headerBudget);
    trailingUrl = escapedUrl;
  }

  const tagsLine = options.hashtagBucketTags
    ? escapeHtml(buildHashtags(candidate.tags, options.hashtagBucketTags))
    : candidate.tags.length > 0
      ? escapeHtml(candidate.tags.slice(0, 8).join(' · '))
      : '';
  // Пустая строка между заголовком и хэштегами — просьба владельца по виду
  // живого поста: без неё название и стена решёток слипаются в один блок.
  // Ставится только там, где хэштеги действительно есть, иначе пост
  // заканчивался бы висящим пустым абзацем.
  const optional = [
    tagsLine ? `${options.hashtagBucketTags ? '\n' : ''}${tagsLine}` : '',
    options.includeExplanation ? why(candidate) : '',
    options.includeLabel && candidate.label ? `лейбл: ${escapeHtml(candidate.label)}` : '',
  ].filter(Boolean);

  const lines = channelLine ? [channelLine, header] : [header];
  let used = channelReserve + header.length + (trailingUrl !== null ? 1 + trailingUrl.length : 0);
  for (const line of optional) {
    if (used + line.length + 1 <= CAPTION_LIMIT) {
      lines.push(line);
      used += line.length + 1;
    }
  }
  if (trailingUrl !== null) lines.push(trailingUrl);
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
    caption: body(candidate, {
      includeExplanation: true,
      channelTitle: channelTitleOf(bucket),
      linkHeader: false,
      includeLabel: true,
    }),
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

/**
 * `bucketTags` — веса тегов бакета, которому адресован пост (`BucketProfile.tags`
 * из `../profile/build.ts`, см. комментарий у `buildHashtags`). Обязательный
 * аргумент, не опциональное поле: без него хэштеги неоткуда взять, а молча
 * откатиться на пустую строку/старый плоский список значило бы тихо потерять
 * ту самую фичу, ради которой поменялся формат — тот же принцип, что и у
 * обязательных `seedTags`/`hardRejectTags` в `score()` (см. `../profile/score.ts`).
 *
 * Заголовок — HTML-ссылка на `candidate.url` (`options.linkHeader: true` в
 * `body()`), а не голый жирный текст с отдельной строкой URL под ним.
 * Проверено (не предположение): Telegram Bot API документирует
 * `LinkPreviewOptions.url` как "URL to use for the link preview. If empty,
 * then the first URL found in the message text will be used" — а "found in
 * the message text" включает URL, спрятанный за entity `text_link` (то, во
 * что HTML-парсер Telegram превращает `<a href="...">видимый текст</a>`),
 * а не только голый автоссылающийся URL: это ровно тот механизм, на котором
 * держится давно известный трюк ботов — слать `<a href="URL">невидимый
 * текст</a>`, чтобы получить превью произвольной страницы под сообщением, не
 * показывая сам URL. Тот же механизм, применённый к видимому тексту
 * ("артист — название" вместо invisible-текста), даёт ту самую большую
 * карточку обложки под постом, которую видел хозяин, — просто заголовок
 * теперь ещё и кликабелен, а голой строки URL под постом больше нет.
 */
export function buildChannelPost(candidate: Candidate, bucketTags: Record<string, number>): string {
  return body(candidate, {
    includeExplanation: false,
    linkHeader: true,
    hashtagBucketTags: bucketTags,
    includeLabel: false,
  });
}
