import type { Http } from '../lib/http.ts';

const ENDPOINT = 'https://bandcamp.com/api/discover/1/discover_web';

export interface DiscoverItem {
  itemId: number;
  url: string;
  title: string;
  artist: string;
}

export interface DiscoverOptions {
  tag: string;
  /** new — новинки, top — продаваемое, rand — случайное. */
  slice: 'new' | 'top' | 'rand';
  size?: number;
}

interface RawResult {
  item_id: number;
  item_url?: string;
  title?: string;
  band_name?: string;
}

interface DiscoverResponse {
  results?: RawResult[];
  /** Общее число результатов в хабе — не путать с длиной results за этот запрос. */
  result_count?: number;
  /** Bandcamp отвечает 200 даже на нерабочий эндпоинт (см. мёртвый dig_deeper) — ошибка приходит в теле. */
  error?: boolean;
  error_message?: string;
}

export async function discover(http: Http, options: DiscoverOptions): Promise<DiscoverItem[]> {
  const body = await http.postJson<DiscoverResponse>(ENDPOINT, {
    category_id: 0,
    tag_norm_names: [options.tag],
    geoname_id: 0,
    slice: options.slice,
    time_facet_id: null,
    size: options.size ?? 60,
    cursor: '*',
    include_result_types: ['a'],
  });
  // Bandcamp отвечает 200 и на нерабочий эндпоинт (так умер dig_deeper: {"error":true,
  // "error_message":"bad function"}). Молча вернуть [] здесь означало бы повторить ту же
  // тихую смерть для тег-хабов — ошибка должна быть видна в логе, а не только в пустом списке.
  if (body.error) {
    console.error(
      `discover: тег "${options.tag}" (slice=${options.slice}) вернул ошибку: ${body.error_message ?? '(без сообщения)'}`,
    );
    return [];
  }
  const results = body.results ?? [];
  // Без пагинации за один вызов виден только первый срез хаба (по умолчанию 60 позиций).
  // Если result_count больше — часть свежих релизов молча теряется, и это должно быть в логе.
  if (typeof body.result_count === 'number' && results.length < body.result_count) {
    console.warn(
      `discover: тег "${options.tag}" (slice=${options.slice}) вернул ${results.length} из ${body.result_count} — выборка усечена`,
    );
  }
  return results.map((item) => ({
    itemId: item.item_id,
    url: (item.item_url ?? '').split('?')[0] ?? '',
    title: item.title ?? '',
    artist: item.band_name ?? '',
  }));
}
