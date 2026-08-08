/**
 * Один заход подборщика (их два в сутки): разобрать нажатия с прошлого раза,
 * собрать кандидатов по четырём бакетам, отправить владельцу в личку ОДИН
 * лучший альбом — или промолчать, если ничего не дотянуло до порога, —
 * подождать реакции (по умолчанию ~20 минут) и выйти. Вся логика — в
 * `src/pipeline/daily.ts` (`runDaily`), этот файл только собирает реальные
 * зависимости (Bandcamp, Telegram, файлы на диске) и передаёт их туда —
 * так же, как `bin/build-profile.ts` и `bin/neighbors.ts` собирают Http и
 * читают/пишут файлы сами, не пряча это в src/.
 *
 * Требует две переменные окружения — токен бота и чат владельца (см.
 * `loadConfig` в `../src/pipeline/daily.ts`). Необязательные ручки:
 * `MIN_TOTAL` (порог, ниже которого заход молчит) и `LISTEN_MINUTES` (окно
 * ожидания нажатий).
 */
import { Http } from '../src/lib/http.ts';
import { readJson, writeJson } from '../src/lib/state.ts';
import { fetchAlbum } from '../src/bandcamp/album.ts';
import { discover } from '../src/bandcamp/discover.ts';
import { fetchBandReleases } from '../src/bandcamp/band.ts';
import { fetchFanItems, fetchFollowedBands } from '../src/bandcamp/fan.ts';
import type { Profile } from '../src/profile/build.ts';
import type { Neighbor } from '../src/pipeline/neighbors.ts';
import { Telegram } from '../src/telegram/api.ts';
import type { Card } from '../src/telegram/card.ts';
import type { ApproveState } from '../src/telegram/approve.ts';
import { editCard, loadConfig, runDaily, type DailyDeps, type DailyOptions } from '../src/pipeline/daily.ts';

const OWNER_FAN_ID = 7566215;

const PATHS = {
  profile: 'data/profile.json',
  neighbors: 'data/neighbors.json',
  state: 'data/state.json',
};

function emptyState(): ApproveState {
  return { pending: [], feedbackTags: {}, seen: [], lastUpdateId: 0 };
}

// Конфигурация — первым делом, до любого файла и любой сети (см.
// комментарий у `loadConfig` в src/pipeline/daily.ts): без токена
// бессмысленны даже безобидные шаги вроде чтения data/profile.json.
const config = loadConfig();

const profile = await readJson<Profile | null>(PATHS.profile, null);
if (!profile) {
  throw new Error(`нет ${PATHS.profile} — сначала запустить npm run build-profile`);
}
// Соседей может не быть, если еженедельный npm run neighbors ещё не
// запускали — это не повод падать: свежак по-прежнему соберётся, архивный
// пул просто окажется пустым (archiveCandidates(..., { neighbors: [] })).
const neighborsFile = await readJson<{ neighbors: Neighbor[] }>(PATHS.neighbors, { neighbors: [] });
const state = await readJson<ApproveState>(PATHS.state, emptyState());

const http = new Http({ cacheDir: '.cache', minDelayMs: 900 });
const telegram = new Telegram(config.botToken);

const deps: DailyDeps = {
  fresh: {
    discover: (opts) => discover(http, opts),
    bandReleases: (subdomain) => fetchBandReleases(http, subdomain),
    album: (url) => fetchAlbum(http, url),
  },
  archive: {
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
  telegram: {
    replaceCard: async (edit) => {
      await editCard(telegram, config.ownerChatId, edit);
    },
    deleteCard: async (messageId) => {
      await telegram.deleteMessage({ chat_id: config.ownerChatId, message_id: messageId });
    },
    ack: async (callbackQueryId, text) => {
      await telegram.answerCallbackQuery({ callback_query_id: callbackQueryId, text });
    },
    getUpdates: (offset) => telegram.getUpdates(offset),
    sendCard: async (card: Card) => {
      const sent = card.photo
        ? await telegram.sendPhoto({
            chat_id: config.ownerChatId,
            photo: card.photo,
            caption: card.caption,
            parse_mode: 'HTML',
            reply_markup: card.keyboard,
          })
        : await telegram.sendMessage({
            chat_id: config.ownerChatId,
            text: card.caption,
            parse_mode: 'HTML',
            reply_markup: card.keyboard,
          });
      return { messageId: sent.message_id };
    },
  },
  persistState: (s) => writeJson(PATHS.state, s),
  now: () => new Date(),
};

/**
 * Числовая переменная окружения с фолбэком на дефолт.
 *
 * Голый `Number(process.env.X ?? '1.5')` тихо превращает опечатку в `NaN`, а
 * `NaN` в этих двух ручках не безобиден: `top.total < NaN` всегда false, то
 * есть `MIN_TOTAL=абв` не «оставит дефолт», а ВЫКЛЮЧИТ порог целиком и бот
 * начнёт слать проходняк; `LISTEN_MINUTES=абв` молча схлопнет окно ожидания в
 * ноль, и кнопка «другой» перестанет отвечать. Обе переменные документированы
 * в README как то, что владелец крутит руками, — значит опечатка в них
 * ожидаема, и падать на ней лучше сразу и громко.
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
  archivePoolLimit: 80,
  alternativesCount: 3,
  hubTagsPerBucket: 4,
  // 1.5 — это STRONG_MATCH из src/profile/score.ts, порог «совпадение
  // достаточно сильное, чтобы пережить шальной стоп-тег». Заход, лучший
  // кандидат которого слабее этого, лучше проведёт молча: смысл всей схемы —
  // один альбом, который стоит послушать, а не один альбом любой ценой.
  minTotal: numberFromEnv('MIN_TOTAL', 1.5),
  // 20 минут, а не прежние 120: карточка одна, и всё ожидание нужно ровно
  // затем, чтобы кнопка «другой» отвечала по горячим следам, а не через 12
  // часов до следующего захода. Нажатие после выхода джоба не теряется —
  // его разберёт дренаж backlog в начале следующего захода.
  listenMinutes: numberFromEnv('LISTEN_MINUTES', 20),
};

await runDaily(profile, neighborsFile.neighbors, state, deps, options);
