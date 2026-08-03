import type { Http } from '../lib/http.ts';

export interface BandRelease {
  url: string;
  title: string;
}

interface GridItem {
  title?: string;
  page_url?: string;
  type?: string;
}

function decodeEntities(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

/**
 * Дискография лежит в атрибуте data-client-items у <ol id="music-grid">,
 * новые релизы идут первыми — проверено на фикстуре lavidaesunmus.bandcamp.com:
 * первая позиция в гриде датирована 26 Sep 2025, вторая — 22 Aug 2025, а
 * последняя — 01 Jan 2002 (даты сверены по ld+json реальных страниц релизов).
 *
 * У групп с единственным релизом грида на странице вовсе нет — /music
 * редиректит на страницу альбома. Это нормальный случай, не ошибка:
 * атрибут просто не находится, и функция тихо отдаёт пустой список.
 *
 * А вот если атрибут найден, но JSON внутри не разбирается — это другой
 * случай: значит Bandcamp сменил формат экранирования атрибута, и молчать
 * об этом нельзя, иначе однажды вся дискография исчезнет без единой
 * зацепки в логе.
 */
export function parseMusicGrid(html: string, subdomain: string): BandRelease[] {
  const match = /<ol[^>]*id="music-grid"[^>]*data-client-items="([^"]*)"/.exec(html);
  if (!match?.[1]) return [];
  let items: GridItem[];
  try {
    items = JSON.parse(decodeEntities(match[1])) as GridItem[];
  } catch (error) {
    console.error(`дискография ${subdomain}: data-client-items не разобрался —`, error);
    return [];
  }
  return items
    .filter((item) => item.type === 'album' && item.page_url?.startsWith('/album/'))
    .map((item) => ({
      url: `https://${subdomain}.bandcamp.com${item.page_url}`,
      title: item.title ?? '',
    }));
}

/**
 * Свежие релизы группы. Берём только начало грида: дискографии бывают по
 * несколько сотен позиций, а нам нужны только новинки.
 *
 * Сетевой сбой (сабдомен не резолвится, страница недоступна) — тихий и
 * ожидаемый: это гоняется по 166 подписок владельца, и то, что у одной из
 * них исчез сайт, не повод шуметь в логе — как и мёртвая ссылка на релиз
 * в album.ts.
 */
export async function fetchBandReleases(
  http: Http,
  subdomain: string,
  limit = 8,
): Promise<BandRelease[]> {
  try {
    const html = await http.getText(`https://${subdomain}.bandcamp.com/music`);
    return parseMusicGrid(html, subdomain).slice(0, limit);
  } catch {
    return [];
  }
}
