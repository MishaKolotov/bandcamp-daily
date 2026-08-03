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

/**
 * &#39; — единственная числовая ссылка, которую Bandcamp реально использует
 * для апострофа в этом атрибуте (проверено на фикстуре), поэтому она
 * прописана явно как «именованная». &amp; должен разбираться последним —
 * иначе `&amp;#39;` превратится в апостроф вместо буквального `&#39;`.
 */
function decodeEntities(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replace(/&#x([0-9a-fA-F]+);/g, (_full, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_full, dec: string) => String.fromCodePoint(Number(dec)))
    .replaceAll('&amp;', '&');
}

/**
 * Дискография лежит в атрибуте data-client-items, новые релизы идут
 * первыми — проверено на фикстуре lavidaesunmus.bandcamp.com: первая
 * позиция в гриде датирована 26 Sep 2025, вторая — 22 Aug 2025 (даты
 * сверены по ld+json реальных страниц релизов). Дальше в хвост порядок не
 * проверялся и не гарантируется — на него ничего не полагается, важен
 * только фронт.
 *
 * Атрибут ищем без привязки к <ol id="music-grid">: это единственный
 * data-client-items на странице, а завязка на порядок атрибутов внутри
 * тега один раз уже чуть не сломала разбор, если бы Bandcamp переставил
 * id и data-client-items местами.
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
  const match = /data-client-items="([^"]*)"/.exec(html);
  if (!match?.[1]) return [];
  let items: GridItem[];
  try {
    items = JSON.parse(decodeEntities(match[1])) as GridItem[];
  } catch (error) {
    console.error(`дискография ${subdomain}: data-client-items не разобрался —`, error);
    return [];
  }
  return items
    .filter(
      (item) =>
        (item.type === 'album' && item.page_url?.startsWith('/album/')) ||
        (item.type === 'track' && item.page_url?.startsWith('/track/')),
    )
    .map((item) => ({
      url: `https://${subdomain}.bandcamp.com${item.page_url}`,
      title: item.title ?? '',
    }));
}

/**
 * Свежие релизы группы. Берём только начало грида: записи в нём не несут
 * дат, так что остановиться раньше нечем — 8 это запас на случай, если
 * дневной прогон однажды пропустили и вышедшие с тех пор релизы не должны
 * потеряться за пределами среза.
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
