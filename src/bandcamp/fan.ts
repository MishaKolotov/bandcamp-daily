import type { Http } from '../lib/http.ts';
import type { BandRef, FanItem } from './types.ts';

const API = 'https://bandcamp.com/api/fancollection/1';
/** Токен «от начала времён»: с ним первая страница отдаёт самые свежие позиции. */
const START_TOKEN = '9999999999::a::';
const PAGE_SIZE = 100;
/**
 * Предел страниц по умолчанию — с запасом под коллекцию владельца: 223 релиза
 * укладываются примерно в 12 запросов, потому что `collection_items`
 * продвигается порциями около 20 позиций, сколько бы ни просили в `count`.
 * Вызывающий код может переопределить его через options.maxPages. Сейчас
 * этой ручкой пользуются только тесты (иначе тесту границы пришлось бы
 * скармливать стабу 60 страниц); в проде читается одна коллекция —
 * владельца, и дефолта хватает с запасом. Ручка оставлена как предохранитель
 * на случай, если снова понадобится читать чужие коллекции произвольного
 * размера.
 */
export const MAX_PAGES = 60;

export interface FanFetchOptions {
  /** Переопределяет MAX_PAGES для одного вызова. */
  maxPages?: number;
}

interface RawItem {
  item_id: number;
  band_id: number;
  item_title?: string;
  band_name?: string;
  item_url?: string;
  url_hints?: { subdomain?: string };
  also_collected_count?: number;
  added?: string;
  /** Курсор пагинации для СЛЕДУЮЩЕЙ страницы — см. комментарий у nextToken(). */
  token?: string;
}

interface RawBand {
  band_id: number;
  name?: string;
  location?: string | null;
  url_hints?: { subdomain?: string };
  token?: string;
}

interface ItemsResponse {
  items?: RawItem[];
  more_available?: boolean;
}

interface BandsResponse {
  followeers?: RawBand[];
  more_available?: boolean;
}

/** Каждый элемент коллекции/вишлиста/подписок несёт курсор для следующей страницы. */
interface TokenBearing {
  token?: string;
}

/**
 * ISO-дата добавления. Отсутствующее поле — тихо откатываемся на
 * "1970-01-01" (это нормально: не у всех эндпоинтов есть `added`).
 * Присутствующее, но неразбираемое значение — не нормально: это значит,
 * что Bandcamp сменил формат даты, и это должно быть видно в логе, а не
 * тихо съедаться тем же фолбэком.
 */
function toIsoDate(raw: string | undefined): string {
  if (!raw) return '1970-01-01';
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    console.warn(`не удалось разобрать дату добавления "${raw}" — использую 1970-01-01`);
    return '1970-01-01';
  }
  return parsed.toISOString().slice(0, 10);
}

/**
 * Курсор для следующей страницы — это поле `token` у ПОСЛЕДНЕГО элемента
 * текущей страницы, а не `last_token` в теле ответа.
 *
 * Проверено вживую на fan_id 7566215: на `collection_items` при count=100
 * `last_token` из тела ответа отстаёт и продвигается примерно на 20 позиций
 * за запрос вместо ~100 — страницы перекрываются почти на 80%, и 223
 * уникальных релиза раздуваются до 783 сырых строк с дублями. На
 * `wishlist_items` и `following_bands` `last_token` в теле ответа совпадал
 * с токеном последнего элемента и не ломался. Но раз один из трёх
 * однотипных эндпоинтов при одинаковом вызове врёт, курсор берётся из
 * `items[].token` / `followeers[].token` единообразно везде, а не выборочно
 * там, где `last_token` подтверждённо надёжен.
 */
function nextToken(entries: TokenBearing[]): string | undefined {
  return entries[entries.length - 1]?.token;
}

/**
 * Постранично обходит эндпоинт и возвращает уже плоский список элементов.
 *
 * Если лимит страниц исчерпан, а Bandcamp всё ещё отвечал more_available —
 * список обрезан не потому, что закончился, а потому что мы перестали
 * спрашивать. Молчать об этом опасно: профиль вкуса, построенный по
 * молча обрезанной коллекции, выглядел бы полным, но считался бы по
 * смещённому «последние N» срезу без единого признака этого в данных.
 */
async function paginate<TEntry extends TokenBearing, TResponse extends { more_available?: boolean }>(
  http: Http,
  endpoint: string,
  fanId: number,
  extract: (page: TResponse) => TEntry[],
  maxPages: number,
): Promise<TEntry[]> {
  const result: TEntry[] = [];
  let token = START_TOKEN;
  let truncated = true;
  for (let page = 0; page < maxPages; page += 1) {
    const body = await http.postJson<TResponse>(`${API}/${endpoint}`, {
      fan_id: fanId,
      older_than_token: token,
      count: PAGE_SIZE,
    });
    const entries = extract(body);
    result.push(...entries);
    const next = nextToken(entries);
    // Bandcamp иногда повторяет тот же токен — это конец, а не бесконечность.
    if (!body.more_available || !next || next === token) {
      truncated = false;
      break;
    }
    token = next;
  }
  if (truncated) {
    console.warn(
      `фан ${fanId}: пагинация ${endpoint} оборвана лимитом ${maxPages} страниц, данные могут быть неполными`,
    );
  }
  return result;
}

export async function fetchFanItems(
  http: Http,
  fanId: number,
  source: 'collection' | 'wishlist',
  options: FanFetchOptions = {},
): Promise<FanItem[]> {
  const endpoint = source === 'collection' ? 'collection_items' : 'wishlist_items';
  const raw = await paginate<RawItem, ItemsResponse>(
    http,
    endpoint,
    fanId,
    (page) => page.items ?? [],
    options.maxPages ?? MAX_PAGES,
  );
  return raw.map((item) => ({
    itemId: item.item_id,
    bandId: item.band_id,
    title: item.item_title ?? '',
    artist: item.band_name ?? '',
    url: item.item_url ?? '',
    subdomain: item.url_hints?.subdomain ?? '',
    alsoCollected: item.also_collected_count ?? 0,
    addedAt: toIsoDate(item.added),
    source,
  }));
}

export async function fetchFollowedBands(
  http: Http,
  fanId: number,
  options: FanFetchOptions = {},
): Promise<BandRef[]> {
  const raw = await paginate<RawBand, BandsResponse>(
    http,
    'following_bands',
    fanId,
    (page) => page.followeers ?? [],
    options.maxPages ?? MAX_PAGES,
  );
  return raw.map((band) => ({
    bandId: band.band_id,
    name: band.name ?? '',
    subdomain: band.url_hints?.subdomain ?? '',
    location: band.location ?? null,
  }));
}
