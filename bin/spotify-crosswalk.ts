/**
 * Переводит вкус из Spotify в теги Bandcamp.
 *
 *   npm run spotify-crosswalk
 *
 * Зачем. Профиль подборщика построен на ~713 покупках на Bandcamp, а слушает
 * владелец заметно шире, чем покупает: в сохранённом Spotify лежат Cherrymoon
 * Trax, Vladimir Dubyshkin, DJ Kuroneko, Aphex Twin — электроника, которой в
 * коллекции нет ни одного релиза. Профиль про неё ничего не знает и знать не
 * может.
 *
 * Почему не просто «взять жанры из Spotify». Их там больше нет: поле `genres`
 * вырезано из объекта артиста (вместе с `followers` и `popularity`), проверено
 * живой пробой. Осталось имя — и его достаточно, если искать артиста там, где
 * всё равно живут кандидаты.
 *
 * Побочная выгода такого маршрута: теги приходят сразу в словаре Bandcamp, том
 * же, которым оперирует скоринг. Проблема несовпадения вокабуляров, неизбежная
 * при переводе жанров Spotify в теги Bandcamp, просто не возникает.
 *
 * Результат — `data/spotify-crosswalk.json`: веса тегов плюс список найденных и
 * ненайденных артистов, чтобы решение о новом бакете принималось по данным, а
 * не на глаз.
 */
import { writeFile } from "node:fs/promises";
import { searchBand, type BandMatch } from "../src/bandcamp/search.ts";

const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN;
if (!clientId || !clientSecret || !refreshToken) {
  console.error("нет SPOTIFY_* в .env — сначала `npm run spotify-auth`");
  process.exit(1);
}

/** Страниц сохранённого (по 50 треков). */
const SAVED_PAGES = 20;
/** Пауза между запросами к Bandcamp — не долбить чужой публичный эндпоинт очередью. */
const DELAY_MS = 250;
const OUT = "data/spotify-crosswalk.json";

async function accessToken(): Promise<string> {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken! }),
  });
  if (!res.ok) throw new Error(`обновление токена не удалось: HTTP ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function spotify<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

const token = await accessToken();

/**
 * Вес артиста складывается из двух источников с разным смыслом.
 *
 * Топ — «слушаю много и давно», вес по месту в списке. Сохранённое — «отобрал
 * руками», вес по числу треков, но с потолком: двадцать треков одного артиста
 * не значат, что он в двадцать раз важнее того, у кого четыре, — а без потолка
 * один артист перевесил бы весь остальной вкус.
 */
const weightByName = new Map<string, number>();
const bump = (name: string, weight: number) =>
  weightByName.set(name, (weightByName.get(name) ?? 0) + weight);

for (const range of ["short_term", "medium_term", "long_term"] as const) {
  const page = await spotify<{ items: { name: string }[] }>(
    token,
    `/me/top/artists?time_range=${range}&limit=50`,
  );
  page.items.forEach((artist, index) => bump(artist.name, 1 - index / Math.max(page.items.length, 1)));
}

const savedCount = new Map<string, number>();
for (let page = 0; page < SAVED_PAGES; page++) {
  const body = await spotify<{ items: { track: { artists: { name: string }[] } }[] }>(
    token,
    `/me/tracks?limit=50&offset=${page * 50}`,
  );
  if (body.items.length === 0) break;
  for (const item of body.items) for (const a of item.track.artists) {
    savedCount.set(a.name, (savedCount.get(a.name) ?? 0) + 1);
  }
  if (body.items.length < 50) break;
}
for (const [name, count] of savedCount) bump(name, Math.min(count, 6) * 0.15);

const artists = [...weightByName.entries()].sort((a, b) => b[1] - a[1]);
console.log(`артистов из Spotify: ${artists.length}`);

const found: { name: string; weight: number; tags: string[] }[] = [];
const missing: string[] = [];
for (let i = 0; i < artists.length; i++) {
  const [name, weight] = artists[i]!;
  let match: BandMatch | null = null;
  try {
    match = await searchBand(name);
  } catch (err) {
    // Один упавший запрос не повод терять весь прогон: артист просто попадёт
    // в ненайденные, и это видно в отчёте.
    console.error(`  поиск «${name}» упал:`, err instanceof Error ? err.message : err);
  }
  if (match && match.tags.length > 0) found.push({ name: match.name, weight, tags: match.tags });
  else missing.push(name);

  if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${artists.length}, найдено ${found.length}`);
  await new Promise((r) => setTimeout(r, DELAY_MS));
}

const tagWeight = new Map<string, number>();
const tagArtists = new Map<string, string[]>();
for (const artist of found) {
  for (const raw of artist.tags) {
    const tag = raw.toLowerCase();
    tagWeight.set(tag, (tagWeight.get(tag) ?? 0) + artist.weight);
    if (!tagArtists.has(tag)) tagArtists.set(tag, []);
    tagArtists.get(tag)!.push(artist.name);
  }
}

const max = Math.max(...tagWeight.values(), 1);
const tags = [...tagWeight.entries()]
  .map(([tag, weight]) => ({
    tag,
    weight: Number((weight / max).toFixed(4)),
    artistCount: tagArtists.get(tag)!.length,
    artists: tagArtists.get(tag)!.slice(0, 6),
  }))
  .sort((a, b) => b.weight - a.weight);

await writeFile(
  OUT,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString().slice(0, 10),
      spotifyArtists: artists.length,
      matchedOnBandcamp: found.length,
      tags,
      missing,
    },
    null,
    2,
  ),
);

console.log(`\nнайдено на Bandcamp: ${found.length} из ${artists.length}`);
console.log(`тегов: ${tags.length}`);
console.log(`записано в ${OUT}`);
