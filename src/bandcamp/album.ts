import type { Http } from '../lib/http.ts';
import type { AlbumDetails } from './types.ts';

interface LdJson {
  name?: string;
  byArtist?: { name?: string };
  publisher?: { name?: string };
  keywords?: string[];
  datePublished?: string;
  image?: string;
}

/** Bandcamp отдаёт даты как "19 Mar 2021 00:00:00 GMT". Приводим к YYYY-MM-DD. */
function toIsoDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

export function parseAlbumPage(html: string): AlbumDetails {
  const match = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  if (!match?.[1]) throw new Error('на странице релиза нет блока ld+json');
  let data: LdJson;
  try {
    data = JSON.parse(match[1]) as LdJson;
  } catch {
    throw new Error('блок ld+json на странице релиза не разобрался');
  }
  return {
    title: data.name ?? '',
    artist: data.byArtist?.name ?? '',
    label: data.publisher?.name ?? null,
    tags: (data.keywords ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean),
    releasedAt: toIsoDate(data.datePublished),
    artUrl: data.image ?? null,
  };
}

/**
 * Страница релиза не меняется, поэтому кэшируется навсегда.
 * Возвращает null, если страница недоступна или не разобралась — один битый
 * релиз не должен ронять весь запуск.
 */
export async function fetchAlbum(http: Http, url: string): Promise<AlbumDetails | null> {
  try {
    return parseAlbumPage(await http.getText(url, { cache: true }));
  } catch {
    return null;
  }
}
