/**
 * Ежедневный запуск: разобрать вчерашние нажатия, собрать сегодняшних
 * кандидатов по четырём бакетам, отправить владельцу карточки на апрув,
 * подождать реакции (по умолчанию ~2 часа) и выйти. Вся логика — в
 * `src/pipeline/daily.ts` (`runDaily`), этот файл только собирает реальные
 * зависимости (Bandcamp, Telegram, файлы на диске) и передаёт их туда —
 * так же, как `bin/build-profile.ts` и `bin/neighbors.ts` собирают Http и
 * читают/пишут файлы сами, не пряча это в src/.
 *
 * Требует две переменные окружения — токен бота и чат владельца (см.
 * `loadConfig` в `../src/pipeline/daily.ts`); их пока не с чем сверить —
 * бот-токен ещё не заведён (Task 22), так что живой прогон этого файла пока
 * не запускался.
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
  return { pending: [], posted: [], feedbackTags: {}, seen: [], lastUpdateId: 0, notices: [] };
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
    notifyOwner: async (text) => {
      const sent = await telegram.sendMessage({ chat_id: config.ownerChatId, text });
      return { messageId: sent.message_id };
    },
  },
  persistState: (s) => writeJson(PATHS.state, s),
  now: () => new Date(),
};

const options: DailyOptions = {
  maxAgeDays: 7,
  maxFutureDays: 30,
  archivePoolLimit: 80,
  alternativesCount: 3,
  hubTagsPerBucket: 4,
  listenMinutes: Number(process.env.LISTEN_MINUTES ?? '120'),
};

await runDaily(profile, neighborsFile.neighbors, state, deps, options);
