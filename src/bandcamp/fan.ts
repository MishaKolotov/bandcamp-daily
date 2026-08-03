import type { Http } from '../lib/http.ts';
import type { BandRef, FanItem } from './types.ts';

const API = 'https://bandcamp.com/api/fancollection/1';
/** Токен «от начала времён»: с ним первая страница отдаёт самые свежие позиции. */
const START_TOKEN = '9999999999::a::';
const PAGE_SIZE = 100;
const MAX_PAGES = 60;

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

interface ItemsPage {
  items?: RawItem[];
  followeers?: RawBand[];
  more_available?: boolean;
}

interface RawBand {
  band_id: number;
  name?: string;
  location?: string | null;
  url_hints?: { subdomain?: string };
  token?: string;
}

function toIsoDate(raw: string | undefined): string {
  const parsed = new Date(raw ?? '');
  return Number.isNaN(parsed.getTime()) ? '1970-01-01' : parsed.toISOString().slice(0, 10);
}

/**
 * Курсор для следующей страницы — это поле `token` у ПОСЛЕДНЕГО элемента
 * текущей страницы, а не `last_token` в теле ответа.
 *
 * Проверено вживую на fan_id 7566215 (223 релиза в коллекции по данным самого
 * Bandcamp): если гонять туда-сюда `last_token` из тела ответа, страницы
 * перекрываются примерно на 80% и коллекция в 223 позиции распухает до 783
 * с кучей дублей — `last_token` там оказался вообще не курсором следующей
 * страницы, а отдельным «снимком состояния всей коллекции» (тем же самым
 * значением, что зашито в HTML профиля fan.collection_data.last_token).
 * С курсором из `items[].token` пагинация останавливается ровно на 223/497/166
 * уникальных позициях без единого дубля — и это совпадает с cчётчиками на
 * самой странице профиля (`collection_count`, `wishlist_data.item_count`,
 * `fan_stats.following_bands_count`).
 */
function nextToken(entries: { token?: string }[]): string | undefined {
  return entries[entries.length - 1]?.token;
}

async function pages(
  http: Http,
  endpoint: string,
  fanId: number,
  extract: (page: ItemsPage) => { token?: string }[],
): Promise<ItemsPage[]> {
  const result: ItemsPage[] = [];
  let token = START_TOKEN;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await http.postJson<ItemsPage>(`${API}/${endpoint}`, {
      fan_id: fanId,
      older_than_token: token,
      count: PAGE_SIZE,
    });
    result.push(body);
    const next = nextToken(extract(body));
    // Bandcamp иногда повторяет тот же токен — это конец, а не бесконечность.
    if (!body.more_available || !next || next === token) break;
    token = next;
  }
  return result;
}

export async function fetchFanItems(
  http: Http,
  fanId: number,
  source: 'collection' | 'wishlist',
): Promise<FanItem[]> {
  const endpoint = source === 'collection' ? 'collection_items' : 'wishlist_items';
  const raw = (
    await pages(http, endpoint, fanId, (page) => page.items ?? [])
  ).flatMap((page) => page.items ?? []);
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

export async function fetchFollowedBands(http: Http, fanId: number): Promise<BandRef[]> {
  const raw = (
    await pages(http, 'following_bands', fanId, (page) => page.followeers ?? [])
  ).flatMap((page) => page.followeers ?? []);
  return raw.map((band) => ({
    bandId: band.band_id,
    name: band.name ?? '',
    subdomain: band.url_hints?.subdomain ?? '',
    location: band.location ?? null,
  }));
}
