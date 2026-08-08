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

test('hubTagsForBucket: половина слотов резервируется под seed-теги, даже когда производные весят больше', () => {
  const bucket: BucketProfile = {
    tags: { a: 1, b: 0.5, c: 0, d: 0.8, seed: 0.5 },
    stopTags: [],
    releaseCount: 10,
    weightSum: 10,
  };
  // Чисто по весу 'seed' (0.5) проиграл бы и 'a' (1), и 'd' (0.8) — старое
  // поведение вернуло бы ['a', 'd'], без единого собственного тега бакета
  // (ровно баг из отчёта: hardcore-punk давал 0 seed-тегов в хабе дня).
  // limit=2 -> seedSlots=1: один слот жёстко под 'seed', второй — под
  // самый тяжёлый производный ('a').
  assert.deepEqual(hubTagsForBucket(bucket, ['seed'], 2), ['seed', 'a']);
});

test('hubTagsForBucket: без тегов профиля откатывается на seedTags бакета, составные — впереди голых', () => {
  const bucket: BucketProfile = { tags: {}, stopTags: [], releaseCount: 0, weightSum: 0 };
  // 'd-beat' — составной (дефис), значит идёт первым при выборе seed-части
  // (см. `orderSeedTagsBySpecificity` в `../profile/buckets.ts`); 'crust' —
  // голый, добирается вторым слотом при доборе остатком seed-тегов.
  assert.deepEqual(hubTagsForBucket(bucket, ['crust', 'd-beat', 'stenchcore'], 2), ['d-beat', 'crust']);
});

test('hubTagsForBucket: профиль из одних нулевых тегов тоже откатывается на seedTags', () => {
  const bucket: BucketProfile = { tags: { a: 0, b: 0 }, stopTags: [], releaseCount: 5, weightSum: 5 };
  assert.deepEqual(hubTagsForBucket(bucket, ['crust'], 3), ['crust']);
});

test('hubTagsForBucket: производных тегов достаточно, но их не хватает на все слоты сверх резерва — остаток добирается seed-тегами', () => {
  const bucket: BucketProfile = { tags: { a: 1, seed: 0.5, other: 0.5 }, stopTags: [], releaseCount: 5, weightSum: 5 };
  // limit=4, seedTags только 2 штуки — seedSlots=2 резервирует оба ('seed',
  // 'other', в порядке объявления, оба голые). Производных на оставшиеся
  // 2 слота хватает только на один ('a') — 4-й слот некому занять, кроме
  // как больше нечем: seed-теги уже исчерпаны, результат короче limit.
  assert.deepEqual(hubTagsForBucket(bucket, ['seed', 'other'], 4), ['seed', 'other', 'a']);
});

test('hubTagsForBucket: регрессия по реальному отчёту — hardcore-punk больше не теряет собственные теги целиком', () => {
  // Форма живого прогона (2026-08): производные теги 'post-punk'/'d-beat'/
  // 'primative'/'crust' обгоняют по весу все шесть seed-тегов бакета
  // (зафиксированных на 0.5) — топ-4 чисто по весу был бы
  // ['post-punk', 'd-beat', 'primative', 'crust'], ни одного панк/хардкор-
  // тега. С резервом это невозможно: минимум половина хаб-тегов дня —
  // собственные (составные предпочтены голым, см. предыдущий тест).
  const bucket: BucketProfile = {
    tags: {
      'post-punk': 1,
      'd-beat': 0.9264,
      primative: 0.8748,
      crust: 0.7874,
      'hardcore punk': 0.5,
      'raw punk': 0.5,
      punk: 0.5,
      hardcore: 0.5,
    },
    stopTags: [],
    releaseCount: 60,
    weightSum: 60,
  };
  const seedTags = ['hardcore punk', 'powerviolence', 'raw punk', 'ukhc', 'punk', 'hardcore'];
  assert.deepEqual(hubTagsForBucket(bucket, seedTags, 4), ['hardcore punk', 'raw punk', 'post-punk', 'd-beat']);
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

test('loadConfig: все недостающие переменные собираются в одну ошибку, а не бросаются по одной', () => {
  // Обе переменные отсутствуют разом — ошибка обязана назвать обе, а не
  // только первую по порядку: иначе владелец узнавал бы о недостающих
  // переменных по одной за прогон, завёл токен, перезапустил, узнал про
  // следующую.
  assert.throws(
    () => loadConfig({}),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes('TELEGRAM_BOT_TOKEN') &&
      error.message.includes('OWNER_CHAT_ID'),
  );
});

test('loadConfig требует только токен и чат владельца', () => {
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: 't', OWNER_CHAT_ID: '42' });
  assert.equal(config.botToken, 't');
  assert.equal(config.ownerChatId, '42');
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
  return { generatedAt: '2026-08-03', buckets, labels: {}, hardRejectTags: [] };
}

function emptyState(): ApproveState {
  return { pending: [], posted: [], feedbackTags: {}, seen: [], lastUpdateId: 0 };
}

interface FakeTelegramDeps {
  getUpdates: DailyDeps['telegram']['getUpdates'];
  sendCard: DailyDeps['telegram']['sendCard'];
  postToChannel: DailyDeps['telegram']['postToChannel'];
  replaceCard: DailyDeps['telegram']['replaceCard'];
  deleteCard: DailyDeps['telegram']['deleteCard'];
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
    deleteCard: async () => {},
    ack: async () => {},
    notifyOwner: async () => ({ messageId: 0 }),
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

test('runDaily: кандидат с тегом из profile.hardRejectTags не отправляется владельцу ни основным пиком, ни запасным', async () => {
  // Прямая проверка сквозного провода profile.hardRejectTags -> selectForBucket
  // -> score() (см. правку в daily.ts): для каждого хаб-тега discover отдаёт
  // пару кандидатов — обычный и его же копию с довеском 'compilation'.
  // Обычный проходит скоринг (несёт тег бакета), копия несёт тот же тег
  // (то есть матчится НЕ слабее), но должна быть убита hardRejectTags
  // целиком — ни как основной пик, ни как «другой кандидат» в запасе.
  const profile = fakeProfile();
  profile.hardRejectTags = ['compilation'];
  const state = emptyState();
  const telegram = baseTelegram();

  const deps: DailyDeps = {
    fresh: {
      discover: async (opts) => [
        { itemId: 1, url: `https://x.test/album/${opts.tag}`, title: opts.tag, artist: 'A', location: null },
        {
          itemId: 2,
          url: `https://x.test/album/${opts.tag}-comp`,
          title: `${opts.tag} comp`,
          artist: 'B',
          location: null,
        },
      ],
      bandReleases: async () => [],
      album: async (url) => {
        const isComp = url.endsWith('-comp');
        const tag = url.split('/').pop()!.replace(/-comp$/, '');
        return album({ tags: isComp ? [tag, 'compilation'] : [tag] });
      },
    },
    archive: { album: async () => null },
    fetchOwnedUrls: async () => [],
    fetchFollowSubdomains: async () => [],
    telegram,
    persistState: async () => {},
    now: () => new Date('2026-08-03'),
  };

  await runDaily(profile, [], state, deps, baseOptions);

  assert.equal(
    state.pending.length,
    BUCKETS.length,
    'ровно по одному пику на бакет — некомпилированный кандидат нашёлся для каждого',
  );
  for (const card of state.pending) {
    assert.ok(
      !card.candidate.tags.includes('compilation'),
      `бакет ${card.bucket} отправил владельцу компиляцию как основной пик`,
    );
    assert.ok(
      card.alternatives.every((alt) => !alt.tags.includes('compilation')),
      `бакет ${card.bucket} держит компиляцию в запасе «другой кандидат»`,
    );
  }
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
  const state = emptyState();

  let pollCalls = 0;
  // Карточки должны появиться ПО ХОДУ прогона, а не быть посажены в pending
  // заранее: всё, что осталось в pending с прошлого прогона, подчистка на
  // шаге 1b сносит до сбора кандидатов (см. `sweepStaleMessages`).
  const skipAll: TelegramUpdate[] = BUCKETS.map((bucket, index) => ({
    update_id: index + 1,
    callback_query: {
      id: `q${index}`,
      data: `skip|${bucket.id}|1`,
      message: { message_id: 1, chat: { id: 1 } },
    },
  }));

  const deps: DailyDeps = {
    fresh: {
      discover: async (opts) => [
        { itemId: 1, url: `https://x.test/album/${opts.tag}`, title: opts.tag, artist: 'A', location: null },
      ],
      bandReleases: async () => [],
      album: async (url) => album({ tags: [url.split('/').pop()!] }),
    },
    archive: { album: async () => null },
    fetchOwnedUrls: async () => [],
    fetchFollowSubdomains: async () => [],
    telegram: {
      ...baseTelegram(),
      // Первый вызов (дренаж backlog) — пусто, второй (опрос) — нажатия,
      // опустошающие pending; счётчик доказывает, что опрос не продолжает
      // молотить getUpdates после того, как разбирать больше нечего.
      getUpdates: async () => {
        pollCalls += 1;
        return pollCalls === 2 ? skipAll : [];
      },
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
      deleteCard: async () => {},
      ack: async () => {},
      notifyOwner: async () => ({ messageId: 0 }),
    },
    persistState: async () => {},
    now: () => new Date('2026-08-03'),
  };

  await runDaily(profile, [], state, deps, { ...baseOptions, listenMinutes: 0 });

  // Один вызов — дренаж backlog на шаге 1. Цикл опроса на шаге 3 не должен
  // был вызвать getUpdates ни разу: until уже в прошлом при listenMinutes=0.
  assert.equal(getUpdatesCalls, 1);
  // Посаженная в pending карточка — хвост прошлого прогона; подчистка на
  // шаге 1b сносит её до сбора кандидатов, а не оставляет висеть.
  assert.equal(state.pending.length, 0);
});

test('runDaily: подчистка сносит вчерашние карточки и уведомления, помечая релизы показанными', async () => {
  const profile = fakeProfile();
  const candidate: Candidate = {
    itemId: 1,
    url: 'https://x.test/album/leftover',
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
    pending: [
      { bucket: BUCKETS[0]!.id, messageId: 11, hasPhoto: false, candidate, matchedTags: [], alternatives: [] },
    ],
    posted: [],
    feedbackTags: {},
    seen: [],
    lastUpdateId: 0,
    notices: [12, 13],
  };

  const deleted: number[] = [];
  const deps: DailyDeps = {
    fresh: { discover: async () => [], bandReleases: async () => [], album: async () => null },
    archive: { album: async () => null },
    fetchOwnedUrls: async () => [],
    fetchFollowSubdomains: async () => [],
    telegram: {
      ...baseTelegram(),
      deleteCard: async (messageId) => {
        deleted.push(messageId);
      },
    },
    persistState: async () => {},
    now: () => new Date('2026-08-03'),
  };

  await runDaily(profile, [], state, deps, baseOptions);

  assert.deepEqual(deleted, [11, 12, 13], 'сносятся и карточки, и служебные уведомления');
  assert.equal(state.pending.length, 0);
  // notices не пуст: бакеты сегодня пустые, и прогон уже записал туда СВОИ
  // уведомления — под снос завтрашней подчисткой. Важно, что вчерашних там
  // больше нет, а не что список пуст.
  assert.ok(!state.notices?.includes(12) && !state.notices?.includes(13), 'вчерашние уведомления забыты');
  assert.ok(
    state.seen.includes(candidate.url),
    'непрожатая карточка считается показанной — иначе тот же релиз придёт завтра снова',
  );
});

test('runDaily: провал удаления одного хвоста не мешает снести остальные', async () => {
  const profile = fakeProfile();
  const state = emptyState();
  state.notices = [21, 22, 23];

  const deleted: number[] = [];
  const deps: DailyDeps = {
    fresh: { discover: async () => [], bandReleases: async () => [], album: async () => null },
    archive: { album: async () => null },
    fetchOwnedUrls: async () => [],
    fetchFollowSubdomains: async () => [],
    telegram: {
      ...baseTelegram(),
      deleteCard: async (messageId) => {
        // Владелец мог снести сообщение руками — Telegram ответит ошибкой.
        if (messageId === 22) throw new Error('message to delete not found');
        deleted.push(messageId);
      },
    },
    persistState: async () => {},
    now: () => new Date('2026-08-03'),
  };

  await runDaily(profile, [], state, deps, baseOptions);

  assert.deepEqual(deleted, [21, 23]);
  assert.ok(
    ![21, 22, 23].some((id) => state.notices?.includes(id)),
    'вчерашние хвосты забыты все разом, включая тот, что не удалился — повторять снос нечего',
  );
});

test('runDaily: пустой бакет (без свежака и архива) шлёт notifyOwner ровно один раз, а не за каждый пул', async () => {
  const profile: Profile = (() => {
    const buckets = {} as Record<BucketId, BucketProfile>;
    for (const bucket of BUCKETS) {
      buckets[bucket.id] = { tags: {}, stopTags: [], releaseCount: 0, weightSum: 0 };
    }
    return { generatedAt: '2026-08-03', buckets, labels: {}, hardRejectTags: [] };
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
        return { messageId: 900 + notes.length };
      },
    },
    persistState: async () => {},
    now: () => new Date('2026-08-03'),
  };

  await runDaily(profile, [], state, deps, baseOptions);

  assert.equal(notes.length, BUCKETS.length, 'по одному уведомлению на каждый пустой бакет, не по два');
  assert.equal(state.pending.length, 0);
});
