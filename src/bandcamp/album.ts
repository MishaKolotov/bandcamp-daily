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

/**
 * При селф-релизе Bandcamp пишет в publisher.name то же имя, что и в byArtist.name.
 * Если считать это лейблом, профиль вкуса накопит веса по именам артистов вместо
 * реальных лейблов, и лейбл-бонус в score.ts выродится в дубликат тегового сигнала.
 */
function resolveLabel(artist: string, publisherName: string | undefined): string | null {
  if (!publisherName) return null;
  if (publisherName.trim().toLowerCase() === artist.trim().toLowerCase()) return null;
  return publisherName;
}

export function parseAlbumPage(html: string): AlbumDetails {
  const match = /<script\b[^>]*\btype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/.exec(
    html,
  );
  if (!match?.[1]) throw new Error('на странице релиза нет блока ld+json');
  let data: LdJson;
  try {
    data = JSON.parse(match[1]) as LdJson;
  } catch {
    throw new Error('блок ld+json на странице релиза не разобрался');
  }
  const artist = data.byArtist?.name ?? '';
  return {
    title: data.name ?? '',
    artist,
    label: resolveLabel(artist, data.publisher?.name),
    tags: (data.keywords ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean),
    releasedAt: toIsoDate(data.datePublished),
    artUrl: data.image ?? null,
  };
}

/**
 * Страница релиза не меняется, поэтому кэшируется навсегда.
 * Возвращает null, если страница недоступна или не разобралась — один битый
 * релиз не должен ронять весь запуск. Сетевой сбой (мёртвый релиз, 404) — это
 * ожидаемо и тихо; поломка формата ld+json — нет, поэтому она видна в логе:
 * если Bandcamp сменит вёрстку, парсер начнёт падать на каждой странице, и без
 * этого лога запуск молча опустеет без объяснений.
 */
export async function fetchAlbum(http: Http, url: string): Promise<AlbumDetails | null> {
  let html: string;
  try {
    html = await http.getText(url, { cache: true });
  } catch {
    return null;
  }
  try {
    return parseAlbumPage(html);
  } catch (error) {
    console.error(`не удалось разобрать страницу релиза ${url}:`, error);
    return null;
  }
}
