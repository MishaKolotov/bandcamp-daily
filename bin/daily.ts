/**
 * Один заход подборщика (их три в сутки): спросить у сайта, что владельцу уже
 * показывали, собрать кандидатов по всем бакетам, отдать сайту ОДИН лучший
 * альбом — или промолчать, если ничего не дотянуло до порога, — и выйти.
 *
 * Карточку, кнопки, диалог описания и пост делает gigamike666.com: у него
 * вебхук, живой круглосуточно, а этот джоб живёт минуты. Здесь остался чистый
 * движок отбора и ни грамма состояния — показанное, штрафы по тегам и жанр
 * прошлого пика лежат в Neon на стороне сайта.
 *
 * Вся логика — в `src/pipeline/daily.ts` (`runDaily`), этот файл только
 * собирает реальные зависимости (Bandcamp, клиент сайта, файлы на диске) и
 * передаёт их туда — так же, как `bin/build-profile.ts` собирает Http и
 * читает/пишет файлы сам, не пряча это в src/.
 *
 * Обязательная переменная окружения одна — `PICKER_SECRET` (см. `loadConfig`).
 * Необязательные ручки: `SITE_URL` (отладка против локального next dev) и
 * `MIN_TOTAL` (порог, ниже которого заход молчит).
 */
import { Http } from '../src/lib/http.ts';
import { readJson } from '../src/lib/state.ts';
import { fetchAlbum } from '../src/bandcamp/album.ts';
import { discover } from '../src/bandcamp/discover.ts';
import { fetchBandReleases } from '../src/bandcamp/band.ts';
import { fetchFanItems, fetchFollowedBands } from '../src/bandcamp/fan.ts';
import type { Profile } from '../src/profile/build.ts';
import { SiteApi } from '../src/site/api.ts';
import { loadConfig, runDaily, type DailyDeps, type DailyOptions } from '../src/pipeline/daily.ts';

const OWNER_FAN_ID = 7566215;

const PATHS = {
  profile: 'data/profile.json',
};

// Конфигурация — первым делом, до любого файла и любой сети (см. комментарий
// у `loadConfig` в src/pipeline/daily.ts): без секрета сайт ответит 401, и
// полчаса обхода Bandcamp уйдут впустую.
const config = loadConfig();

const profile = await readJson<Profile | null>(PATHS.profile, null);
if (!profile) {
  throw new Error(`нет ${PATHS.profile} — сначала запустить npm run build-profile`);
}

const http = new Http({ cacheDir: '.cache', minDelayMs: 900 });
const site = new SiteApi(config.siteUrl, config.pickerSecret);

const deps: DailyDeps = {
  fresh: {
    discover: (opts) => discover(http, opts),
    bandReleases: (subdomain) => fetchBandReleases(http, subdomain),
    album: (url) => fetchAlbum(http, url),
  },
  fetchOwnedUrls: async () => {
    const [collection, wishlist] = [
      await fetchFanItems(http, OWNER_FAN_ID, 'collection'),
      await fetchFanItems(http, OWNER_FAN_ID, 'wishlist'),
    ];
    return [...collection, ...wishlist].map((item) => item.url);
  },
  fetchFollowSubdomains: async () => {
    const follows = await fetchFollowedBands(http, OWNER_FAN_ID);
    return follows.map((band) => band.subdomain).filter(Boolean);
  },
  site: {
    readContext: () => site.readContext(),
    sendPick: (pick) => site.sendPick(pick),
  },
  now: () => new Date(),
};

/**
 * Числовая переменная окружения с фолбэком на дефолт.
 *
 * Голый `Number(process.env.X ?? '1.5')` тихо превращает опечатку в `NaN`, а
 * `NaN` в этой ручке не безобиден: `top.total < NaN` всегда false, то есть
 * `MIN_TOTAL=абв` не «оставит дефолт», а ВЫКЛЮЧИТ порог целиком и подборщик
 * начнёт слать проходняк. Переменная документирована в README как то, что
 * владелец крутит руками, — значит опечатка в ней ожидаема, и падать на ней
 * лучше сразу и громко.
 */
function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`переменная окружения ${name} должна быть числом, а не ${JSON.stringify(raw)}`);
  }
  return parsed;
}

const options: DailyOptions = {
  maxAgeDays: 7,
  maxFutureDays: 30,
  // Очередь «Другой» — вся, а не первые несколько: владелец листает её, пока
  // не кончится. Порог `minTotal` её и так режет по существу, так что 40 —
  // это не «сколько показать», а потолок на случай урожайного дня.
  //
  // Потолок всё же нужен: очередь целиком уезжает в теле POST на сайт и там
  // ложится одной jsonb-строкой. Сорок кандидатов — это килобайт двадцать,
  // а несколько сотен превратили бы каждую отправку карточки в мегабайтный
  // запрос ради вариантов, до которых владелец никогда не долистает.
  alternativesCount: numberFromEnv('ALTERNATIVES', 40),
  hubTagsPerBucket: 4,
  // 1.5 — это STRONG_MATCH из src/profile/score.ts, порог «совпадение
  // достаточно сильное, чтобы пережить шальной стоп-тег». Заход, лучший
  // кандидат которого слабее этого, лучше проведёт молча: смысл всей схемы —
  // один альбом, который стоит послушать, а не один альбом любой ценой.
  minTotal: numberFromEnv('MIN_TOTAL', 1.5),
};

await runDaily(profile, deps, options);
