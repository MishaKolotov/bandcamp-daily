/**
 * Разовая авторизация в Spotify: обменять согласие владельца на refresh-токен.
 *
 * Запускается руками один раз. Поднимает локальный сервер на 127.0.0.1:8888,
 * открывает браузер, ловит редирект с кодом, меняет код на токены и дописывает
 * refresh-токен в `.env`. Дальше сбор данных (`bin/spotify-taste.ts`) работает
 * без браузера: refresh-токен живёт, пока владелец не отзовёт доступ.
 *
 * Никаких секретов в stdout: печатаются только шаги и итог. Значения токенов
 * не логируются нигде — ни при успехе, ни в сообщениях об ошибках.
 *
 *   npm run spotify-auth
 *
 * Права запрашиваются минимальные:
 *   user-top-read     — топ артистов и треков (жанры лежат на артистах)
 *   user-library-read — сохранённое, второй источник артистов
 * Ни плейлистов, ни управления воспроизведением, ни записи — подборщику нужно
 * только «что ты слушаешь», а лишний scope это лишний риск в чужом токене.
 */
import { createServer } from "node:http";
import { appendFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const REDIRECT_URI = "http://127.0.0.1:8888/callback";
const SCOPES = "user-top-read user-library-read";
const ENV_PATH = ".env";

const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error(
    "нет SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET в .env — возьми их в настройках приложения на developer.spotify.com",
  );
  process.exit(1);
}

const existing = await readFile(ENV_PATH, "utf8").catch(() => "");
if (/^SPOTIFY_REFRESH_TOKEN=/m.test(existing)) {
  console.error(
    "в .env уже есть SPOTIFY_REFRESH_TOKEN. Если хочешь перевыпустить — удали строку руками и запусти снова.",
  );
  process.exit(1);
}

// state защищает от подмены ответа: Spotify вернёт его как есть, и мы сверим.
const state = randomBytes(16).toString("hex");

const authUrl = new URL("https://accounts.spotify.com/authorize");
authUrl.searchParams.set("client_id", clientId);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("scope", SCOPES);
authUrl.searchParams.set("state", state);

const code = await new Promise<string>((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", REDIRECT_URI);
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get("error");
    const returned = url.searchParams.get("state");
    const received = url.searchParams.get("code");

    const done = (message: string) => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(message);
      server.close();
    };

    if (error) {
      done("отказано в доступе — можно закрыть вкладку");
      reject(new Error(`Spotify вернул ошибку: ${error}`));
    } else if (returned !== state) {
      done("несовпадение state — можно закрыть вкладку");
      reject(new Error("несовпадение state: ответ пришёл не на наш запрос"));
    } else if (!received) {
      done("нет кода — можно закрыть вкладку");
      reject(new Error("Spotify не вернул код"));
    } else {
      done("готово, возвращайся в терминал");
      resolve(received);
    }
  });

  server.listen(8888, "127.0.0.1", () => {
    console.log("открываю браузер для подтверждения доступа…");
    console.log(`если не открылся сам — зайди сюда:\n${authUrl.toString()}\n`);
    spawn("open", [authUrl.toString()], { stdio: "ignore", detached: true }).unref();
  });

  // Без таймаута процесс висел бы вечно, если владелец закрыл вкладку молча.
  setTimeout(() => {
    server.close();
    reject(new Error("не дождался подтверждения за 5 минут"));
  }, 5 * 60_000).unref();
});

const tokenResponse = await fetch("https://accounts.spotify.com/api/token", {
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
  },
  body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }),
});

if (!tokenResponse.ok) {
  // Тело ответа может содержать эхо параметров запроса — печатаем только статус.
  console.error(`обмен кода на токен не удался: HTTP ${tokenResponse.status}`);
  process.exit(1);
}

const tokens = (await tokenResponse.json()) as { refresh_token?: string };
if (!tokens.refresh_token) {
  console.error("Spotify не вернул refresh_token");
  process.exit(1);
}

const prefix = existing.endsWith("\n") || existing === "" ? "" : "\n";
await appendFile(ENV_PATH, `${prefix}SPOTIFY_REFRESH_TOKEN=${tokens.refresh_token}\n`);
console.log("готово: SPOTIFY_REFRESH_TOKEN дописан в .env");
