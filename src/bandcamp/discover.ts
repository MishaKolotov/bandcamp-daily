import type { Http } from '../lib/http.ts';

const ENDPOINT = 'https://bandcamp.com/api/discover/1/discover_web';

export interface DiscoverItem {
  itemId: number;
  url: string;
  title: string;
  artist: string;
  location: string | null;
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
  band_location?: string | null;
}

interface DiscoverResponse {
  results?: RawResult[];
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
  return (body.results ?? []).map((item) => ({
    itemId: item.item_id,
    url: (item.item_url ?? '').split('?')[0] ?? '',
    title: item.title ?? '',
    artist: item.band_name ?? '',
    location: item.band_location ?? null,
  }));
}
