import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AlbumDetails, BucketId, Candidate } from '../bandcamp/types.ts';
import { BUCKETS } from '../profile/buckets.ts';
import type { BucketProfile, Profile } from '../profile/build.ts';
import type { ApproveState, CardEdit } from '../telegram/approve.ts';
import type { TelegramUpdate } from '../telegram/api.ts';
import type { Card } from '../telegram/card.ts';
import {
  bucketEmptyMessage,
  editCard,
  hubTagsForBucket,
  loadConfig,
  runDaily,
  type DailyDeps,
  type DailyOptions,
} from './daily.ts';
import type { PoolOutcome } from './select.ts';

// ---------------------------------------------------------------------------
// hubTagsForBucket
// ---------------------------------------------------------------------------

test('hubTagsForBucket: берёт теги бакета по убыванию веса, нулевые не считаются сигналом', () => {
  const bucket: BucketProfile = {
    tags: { a: 1, b: 0.5, c: 0, d: 0.8 },
    stopTags: [],
    releaseCount: 10,
    weightSum: 10,
  };
  assert.deepEqual(hubTagsForBucket(bucket, ['seed'], 2), ['a', 'd']);
});

test('hubTagsForBucket: без тегов профиля откатывается на seedTags бакета', () => {
  const bucket: BucketProfile = { tags: {}, stopTags: [], releaseCount: 0, weightSum: 0 };
  assert.deepEqual(hubTagsForBucket(bucket, ['crust', 'd-beat', 'stenchcore'], 2), ['crust', 'd-beat']);
});

test('hubTagsForBucket: профиль из одних нулевых тегов тоже откатывается на seedTags', () => {
  const bucket: BucketProfile = { tags: { a: 0, b: 0 }, stopTags: [], releaseCount: 5, weightSum: 5 };
  assert.deepEqual(hubTagsForBucket(bucket, ['crust'], 3), ['crust']);
});

// ---------------------------------------------------------------------------
// bucketEmptyMessage
// ---------------------------------------------------------------------------

const notOffered: PoolOutcome = { status: 'not-offered' };
const noMatch: PoolOutcome = { status: 'no-match' };
const picked: PoolOutcome = {
  status: 'picked',
  candidate: {
    itemId: 1,
    url: 'https://x.test/album/1',
    title: 'T',
    artist: 'A',
    label: null,
    tags: [],
    releasedAt: null,
    artUrl: null,
    alsoCollected: 0,
    origin: 'fresh',
  },
  matchedTags: [],
  total: 1,
  alternatives: [],
};

const bucketDef = BUCKETS[0]!;

test('bucketEmptyMessage: null, если хотя бы один пул дал карточку', () => {
  assert.equal(bucketEmptyMessage(bucketDef, { fresh: picked, archive: notOffered }), null);
  assert.equal(bucketEmptyMessage(bucketDef, { fresh: notOffered, archive: picked }), null);
});

test('bucketEmptyMessage: оба пула пусты — сообщение различает not-offered и no-match по каждому пулу', () => {
  const message = bucketEmptyMessage(bucketDef, { fresh: notOffered, archive: noMatch });
  assert.match(message ?? '', /свежак.*нечего было предложить/is);
  assert.match(message ?? '', /архив.*профиль отбраковал/is);
});

// ---------------------------------------------------------------------------
// editCard
// ---------------------------------------------------------------------------

function fakeTelegram() {
  const calls: string[] = [];
  return {
    calls,
    editMessageCaption: async (payload: { message_id: number }) => {
      calls.push(`caption:${payload.message_id}`);
    },
    editMessageText: async (payload: { message_id: number }) => {
      calls.push(`text:${payload.message_id}`);
    },
  };
}

test('editCard: карточка, отправленная как фото, редактируется editMessageCaption', async () => {
  const telegram = fakeTelegram();
  const edit: CardEdit = { messageId: 7, hasPhoto: true, caption: 'c', keyboard: { inline_keyboard: [] } };
  await editCard(telegram, 'chat', edit);
  assert.deepEqual(telegram.calls, ['caption:7']);
});

test('editCard: карточка, отправленная как текст, редактируется editMessageText', async () => {
  const telegram = fakeTelegram();
  const edit: CardEdit = { messageId: 7, hasPhoto: false, caption: 'c', keyboard: { inline_keyboard: [] } };
  await editCard(telegram, 'chat', edit);
  assert.deepEqual(telegram.calls, ['text:7']);
});

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

/** Полный набор переменных окружения — по BUCKETS, а не по захардкоженным именам. */
function fullEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { TELEGRAM_BOT_TOKEN: 'tok', OWNER_CHAT_ID: '123' };
  for (const bucket of BUCKETS) env[bucket.channelEnv] = `chat-${bucket.id}`;
  return env;
}

test('loadConfig: с полным окружением строит по записи канала на каждый бакет из BUCKETS', () => {
  const config = loadConfig(fullEnv());
  assert.equal(config.botToken, 'tok');
  assert.equal(config.ownerChatId, '123');
  // Не сверяем с захардкоженным списком имён бакетов — сверяем с самим BUCKETS,
  // чтобы тест не устарел молча, если список бакетов снова расширится.
  for (const bucket of BUCKETS) {
    assert.equal(config.channelIdByBucket.get(bucket.id), `chat-${bucket.id}`);
  }
  assert.equal(config.channelIdByBucket.size, BUCKETS.length);
});

test('loadConfig: все недостающие переменные собираются в одну ошибку, а не бросаются по одной', () => {
  const env = fullEnv();
  delete env.TELEGRAM_BOT_TOKEN;
  delete env[BUCKETS[0]!.channelEnv];
  assert.throws(
    () => loadConfig(env),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes('TELEGRAM_BOT_TOKEN') &&
      error.message.includes(BUCKETS[0]!.channelEnv),
  );
});

// ---------------------------------------------------------------------------
// runDaily
// ---------------------------------------------------------------------------

const album = (over: Partial<AlbumDetails> = {}): AlbumDetails => ({
  title: 'T',
  artist: 'A',
  label: null,
  tags: [],
  releasedAt: '2026-08-03',
  artUrl: null,
  ...over,
});

/** Профиль, где у каждого бакета из BUCKETS ровно один опорный тег весом 0.5 — построен по BUCKETS, не по именам. */
function fakeProfile(): Profile {
  const buckets = {} as Record<BucketId, BucketProfile>;
  for (const bucket of BUCKETS) {
    buckets[bucket.id] = {
      tags: { [bucket.seedTags[0]!]: 0.5 },
      stopTags: [],
      releaseCount: 1,
      weightSum: 1,
    };
  }
  return { generatedAt: '2026-08-03', buckets, labels: {} };
}

function emptyState(): ApproveState {
  return { pending: [], posted: [], feedbackTags: {}, seen: [], lastUpdateId: 0 };
}

interface FakeTelegramDeps {
  getUpdates: DailyDeps['telegram']['getUpdates'];
  sendCard: DailyDeps['telegram']['sendCard'];
  postToChannel: DailyDeps['telegram']['postToChannel'];
  replaceCard: DailyDeps['telegram']['replaceCard'];
  closeCard: DailyDeps['telegram']['closeCard'];
  ack: DailyDeps['telegram']['ack'];
  notifyOwner: DailyDeps['telegram']['notifyOwner'];
  sentCards: Card[];
}

function baseTelegram(updateBatches: TelegramUpdate[][] = []): FakeTelegramDeps {
  const batches = [...updateBatches];
  const sentCards: Card[] = [];
  let nextMessageId = 1000;
  return {
    sentCards,
    getUpdates: async () => batches.shift() ?? [],
    sendCard: async (card) => {
      sentCards.push(card);
      nextMessageId += 1;
      return { messageId: nextMessageId };
    },
    postToChannel: async () => {},
    replaceCard: async () => {},
    closeCard: async () => {},
    ack: async () => {},
    notifyOwner: async () => {},
  };
}

const baseOptions: DailyOptions = {
  maxAgeDays: 7,
  maxFutureDays: 30,
  archivePoolLimit: 10,
  alternativesCount: 3,
  hubTagsPerBucket: 4,
  listenMinutes: 0,
};

test('runDaily: обходит бакеты generично по BUCKETS — не по захардкоженным именам', async () => {
  const profile = fakeProfile();
  const state = emptyState();
  const persisted: ApproveState[] = [];
  const telegram = baseTelegram();

  const deps: DailyDeps = {
    fresh: {
      // Один свежий кандидат на хаб-тег — url кодирует сам тег, так что
      // фейку не нужно знать имена бакетов, только сам запрошенный тег.
      discover: async (opts) => [
        { itemId: 1, url: `https://x.test/album/${opts.tag}`, title: opts.tag, artist: 'A', location: null },
      ],
      bandReleases: async () => [],
      album: async (url) => {
        const tag = url.split('/').pop()!;
        return album({ tags: [tag] });
      },
    },
    archive: { album: async () => null },
    fetchOwnedUrls: async () => [],
    fetchFollowSubdomains: async () => [],
    telegram,
    persistState: async (s) => {
      persisted.push(JSON.parse(JSON.stringify(s)));
    },
    now: () => new Date('2026-08-03'),
  };

  await runDaily(profile, [], state, deps, baseOptions);

  // Ровно один пик на бакет (свежак; архив пуст) — и набор бакетов в
  // pending в точности совпадает с BUCKETS.map(b => b.id), не с каким-то
  // захардкоженным списком в тесте.
  assert.equal(state.pending.length, BUCKETS.length);
  assert.deepEqual(
    new Set(state.pending.map((card) => card.bucket)),
    new Set(BUCKETS.map((bucket) => bucket.id)),
  );
  assert.ok(persisted.length > 0, 'состояние должно было персиститься хотя бы раз');
});

test('runDaily: разбор нажатия (post) во время дренажа backlog пишет в persistState ровно то, что произвёл handleUpdates', async () => {
  const profile = fakeProfile();
  const bucketId = BUCKETS[0]!.id;
  const candidate: Candidate = {
    itemId: 42,
    url: 'https://x.test/album/42',
    title: 'T',
    artist: 'A',
    label: null,
    tags: [BUCKETS[0]!.seedTags[0]!],
    releasedAt: '2026-08-01',
    artUrl: null,
    alsoCollected: 0,
    origin: 'fresh',
  };
  const state: ApproveState = {
    pending: [{ bucket: bucketId, messageId: 500, hasPhoto: false, candidate, matchedTags: [], alternatives: [] }],
    posted: [],
    feedbackTags: {},
    seen: [],
    lastUpdateId: 0,
  };

  const postUpdate: TelegramUpdate = {
    update_id: 9,
    callback_query: { id: 'q1', data: `post|${bucketId}|42`, message: { message_id: 500, chat: { id: 1 } } },
  };

  const persisted: ApproveState[] = [];
  const telegram = baseTelegram([[postUpdate]]);

  const deps: DailyDeps = {
    fresh: { discover: async () => [], bandReleases: async () => [], album: async () => null },
    archive: { album: async () => null },
    fetchOwnedUrls: async () => [],
    fetchFollowSubdomains: async () => [],
    telegram,
    persistState: async (s) => {
      persisted.push(JSON.parse(JSON.stringify(s)));
    },
    now: () => new Date('2026-08-03'),
  };

  await runDaily(profile, [], state, deps, { ...baseOptions, listenMinutes: 0 });

  assert.equal(state.pending.length, 0);
  assert.equal(state.posted.length, 1);
  assert.equal(state.posted[0]?.url, candidate.url);
  assert.ok(persisted.length > 0);
  // Последний персист обязан совпадать с реальным итоговым состоянием —
  // ровно то, что произвёл handleUpdates, а не устаревший снимок.
  assert.deepEqual(persisted[persisted.length - 1], JSON.parse(JSON.stringify(state)));
});

test('runDaily: опрос останавливается раньше срока, как только pending опустел', async () => {
  const profile = fakeProfile();
  const bucketId = BUCKETS[0]!.id;
  const candidate: Candidate = {
    itemId: 1,
    url: 'https://x.test/album/1',
    title: 'T',
    artist: 'A',
    label: null,
    tags: [],
    releasedAt: '2026-08-01',
    artUrl: null,
    alsoCollected: 0,
    origin: 'fresh',
  };
  const state: ApproveState = {
    pending: [{ bucket: bucketId, messageId: 1, hasPhoto: false, candidate, matchedTags: [], alternatives: [] }],
    posted: [],
    feedbackTags: {},
    seen: [],
    lastUpdateId: 0,
  };

  let pollCalls = 0;
  const skipUpdate: TelegramUpdate = {
    update_id: 1,
    callback_query: { id: 'q', data: `skip|${bucketId}|1`, message: { message_id: 1, chat: { id: 1 } } },
  };

  const deps: DailyDeps = {
    fresh: { discover: async () => [], bandReleases: async () => [], album: async () => null },
    archive: { album: async () => null },
    fetchOwnedUrls: async () => [],
    fetchFollowSubdomains: async () => [],
    telegram: {
      // Первый вызов (дренаж backlog) — пусто, второй (опрос) — нажатие,
      // опустошающее pending; счётчик доказывает, что опрос не продолжает
      // молотить getUpdates после того, как разбирать больше нечего.
      getUpdates: async () => {
        pollCalls += 1;
        return pollCalls === 2 ? [skipUpdate] : [];
      },
      sendCard: async () => ({ messageId: 1 }),
      postToChannel: async () => {},
      replaceCard: async () => {},
      closeCard: async () => {},
      ack: async () => {},
      notifyOwner: async () => {},
    },
    persistState: async () => {},
    // Часы не двигаются — "до" всегда далеко в будущем относительно
    // фиксированного now(), так что выход возможен только по опустевшему pending.
    now: () => new Date('2026-08-03'),
  };

  await runDaily(profile, [], state, deps, { ...baseOptions, listenMinutes: 120 });

  assert.equal(state.pending.length, 0);
  assert.equal(pollCalls, 2, 'опрос обязан остановиться сразу после того, как pending опустел');
});

test('runDaily: listenMinutes 0 — опрос не запускается вовсе, если время уже вышло', async () => {
  const profile = fakeProfile();
  const bucketId = BUCKETS[0]!.id;
  const candidate: Candidate = {
    itemId: 1,
    url: 'https://x.test/album/1',
    title: 'T',
    artist: 'A',
    label: null,
    tags: [],
    releasedAt: '2026-08-01',
    artUrl: null,
    alsoCollected: 0,
    origin: 'fresh',
  };
  const state: ApproveState = {
    pending: [{ bucket: bucketId, messageId: 1, hasPhoto: false, candidate, matchedTags: [], alternatives: [] }],
    posted: [],
    feedbackTags: {},
    seen: [],
    lastUpdateId: 0,
  };

  let getUpdatesCalls = 0;
  const deps: DailyDeps = {
    fresh: { discover: async () => [], bandReleases: async () => [], album: async () => null },
    archive: { album: async () => null },
    fetchOwnedUrls: async () => [],
    fetchFollowSubdomains: async () => [],
    telegram: {
      getUpdates: async () => {
        getUpdatesCalls += 1;
        return [];
      },
      sendCard: async () => ({ messageId: 1 }),
      postToChannel: async () => {},
      replaceCard: async () => {},
      closeCard: async () => {},
      ack: async () => {},
      notifyOwner: async () => {},
    },
    persistState: async () => {},
    now: () => new Date('2026-08-03'),
  };

  await runDaily(profile, [], state, deps, { ...baseOptions, listenMinutes: 0 });

  // Один вызов — дренаж backlog на шаге 1. Цикл опроса на шаге 3 не должен
  // был вызвать getUpdates ни разу: until уже в прошлом при listenMinutes=0.
  assert.equal(getUpdatesCalls, 1);
  assert.equal(state.pending.length, 1, 'карточка остаётся висеть — её никто не тронул');
});

test('runDaily: пустой бакет (без свежака и архива) шлёт notifyOwner ровно один раз, а не за каждый пул', async () => {
  const profile: Profile = (() => {
    const buckets = {} as Record<BucketId, BucketProfile>;
    for (const bucket of BUCKETS) {
      buckets[bucket.id] = { tags: {}, stopTags: [], releaseCount: 0, weightSum: 0 };
    }
    return { generatedAt: '2026-08-03', buckets, labels: {} };
  })();
  const state = emptyState();
  const notes: string[] = [];

  const deps: DailyDeps = {
    fresh: { discover: async () => [], bandReleases: async () => [], album: async () => null },
    archive: { album: async () => null },
    fetchOwnedUrls: async () => [],
    fetchFollowSubdomains: async () => [],
    telegram: {
      ...baseTelegram(),
      notifyOwner: async (text) => {
        notes.push(text);
      },
    },
    persistState: async () => {},
    now: () => new Date('2026-08-03'),
  };

  await runDaily(profile, [], state, deps, baseOptions);

  assert.equal(notes.length, BUCKETS.length, 'по одному уведомлению на каждый пустой бакет, не по два');
  assert.equal(state.pending.length, 0);
});
