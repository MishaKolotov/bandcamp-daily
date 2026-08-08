/**
 * Собирает вкус владельца из Spotify: топ-артисты и артисты сохранённых треков
 * → их жанры → веса. Пишет `data/spotify-taste.json`.
 *
 *   npm run spotify-taste
 *
 * Зачем это вообще: профиль подборщика построен на ~713 покупках на Bandcamp, а
 * покупает владелец заметно уже, чем слушает. Электронной музыки в коллекции
 * нет вовсе, хотя слушает он её. Spotify отвечает на вопрос «что ты слушаешь»,
 * Bandcamp остаётся источником кандидатов.
 *
 * Почему именно артисты: жанры в Spotify висят на артисте, не на треке и не на
 * альбоме. Другого источника жанра у API нет.
 *
 * Что НЕ используется: `audio-features`, `related-artists` и `recommendations`
 * закрыты для новых приложений с ноября 2024. Здесь они и не нужны.
 *
 * Отдельная засада, найденная живой пробой: батч-эндпоинт `/artists?ids=` тоже
 * отдаёт 403 новым приложениям, хотя поштучный `/artists/{id}` работает. Отсюда
 * запрос жанров по одному и лимит `SAVED_ARTIST_LIMIT` — иначе на библиотеке в
 * тысячу артистов прогон растянулся бы на десяток минут ради длинного хвоста
 * артистов с одним сохранённым треком.
 */
import { writeFile } from "node:fs/promises";

const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN;
if (!clientId || !clientSecret || !refreshToken) {
  console.error("нет SPOTIFY_* в .env — сначала `npm run spotify-auth`");
  process.exit(1);
}

/** Сколько страниц сохранённого читать. 20 × 50 = 1000 треков — потолок, чтобы прогон не растягивался. */
const SAVED_PAGES = 20;
/** Сколько артистов сохранённого дозапрашивать поштучно, по убыванию числа треков. */
const SAVED_ARTIST_LIMIT = 300;
const OUT = "data/spotify-taste.json";

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
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("Spotify не вернул access_token");
  return body.access_token;
}

interface SpotifyArtist {
  id: string;
  name: string;
  genres?: string[];
}

async function api<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 429) {
    // Ретрай ровно один, по подсказке самого Spotify: прогон разовый и ручной,
    // городить экспоненциальный бэкофф ради него — лишнее.
    const wait = Number(res.headers.get("retry-after") ?? "2");
    console.log(`  рейт-лимит, жду ${wait}с…`);
    await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
    return api<T>(token, path);
  }
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

const token = await accessToken();

// 1. Топ-артисты по трём окнам. Окна пересекаются, и это намеренно: артист,
// попавший во все три, весит больше — он не разовое увлечение.
const artistsById = new Map<string, SpotifyArtist>();
const rankWeight = new Map<string, number>();

for (const range of ["short_term", "medium_term", "long_term"] as const) {
  const page = await api<{ items: SpotifyArtist[] }>(token, `/me/top/artists?time_range=${range}&limit=50`);
  console.log(`топ-артисты (${range}): ${page.items.length}`);
  page.items.forEach((artist, index) => {
    artistsById.set(artist.id, artist);
    // Позиция в топе важнее окна: первый артист месяца и первый за всё время
    // весят одинаково, а пятидесятый — впятеро меньше первого.
    const weight = 1 - index / page.items.length;
    rankWeight.set(artist.id, (rankWeight.get(artist.id) ?? 0) + weight);
  });
}

// 2. Артисты сохранённых треков. Веса не несут — это «слушаю», а не «люблю
// больше всего», — но расширяют охват жанров.
const savedFrequency = new Map<string, number>();
for (let page = 0; page < SAVED_PAGES; page++) {
  const body = await api<{ items: { track: { artists: { id: string }[] } }[] }>(
    token,
    `/me/tracks?limit=50&offset=${page * 50}`,
  );
  if (body.items.length === 0) break;
  for (const item of body.items) {
    for (const a of item.track.artists) savedFrequency.set(a.id, (savedFrequency.get(a.id) ?? 0) + 1);
  }
  if (body.items.length < 50) break;
}
console.log(`артистов из сохранённого: ${savedFrequency.size}`);

// 3. Жанры для тех, кого ещё не знаем — поштучно (батч закрыт, см. шапку) и по
// убыванию числа сохранённых треков: артист с двадцатью треками говорит о вкусе
// больше, чем случайно залайканный одиночный трек, а хвост всё равно обрезается
// лимитом.
const unknown = [...savedFrequency.entries()]
  .filter(([id]) => !artistsById.has(id))
  .sort((a, b) => b[1] - a[1])
  .slice(0, SAVED_ARTIST_LIMIT)
  .map(([id]) => id);
console.log(`дозапрашиваю жанры поштучно: ${unknown.length}`);
for (let i = 0; i < unknown.length; i++) {
  const artist = await api<SpotifyArtist>(token, `/artists/${unknown[i]}`);
  if (artist?.id) artistsById.set(artist.id, artist);
  if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${unknown.length}`);
  // Пауза, чтобы не влететь в рейт-лимит на трёх сотнях подряд.
  await new Promise((r) => setTimeout(r, 60));
}

// 4. Свести в веса по жанрам.
const genreWeight = new Map<string, number>();
const genreArtists = new Map<string, Set<string>>();
for (const artist of artistsById.values()) {
  // Артист из топа несёт свой ранговый вес; артист только из сохранённого — 0.2:
  // присутствие в библиотеке это сигнал, но много слабее места в топе.
  const weight = rankWeight.get(artist.id) ?? 0.2;
  for (const genre of artist.genres ?? []) {
    genreWeight.set(genre, (genreWeight.get(genre) ?? 0) + weight);
    if (!genreArtists.has(genre)) genreArtists.set(genre, new Set());
    genreArtists.get(genre)!.add(artist.name);
  }
}

const max = Math.max(...genreWeight.values(), 1);
const genres = [...genreWeight.entries()]
  .map(([genre, weight]) => ({
    genre,
    weight: Number((weight / max).toFixed(4)),
    artists: [...(genreArtists.get(genre) ?? [])].slice(0, 5),
  }))
  .sort((a, b) => b.weight - a.weight);

await writeFile(
  OUT,
  JSON.stringify({ generatedAt: new Date().toISOString().slice(0, 10), artistCount: artistsById.size, genres }, null, 2),
);
console.log(`\nвсего артистов: ${artistsById.size}, жанров: ${genres.length}`);
console.log(`записано в ${OUT}`);
