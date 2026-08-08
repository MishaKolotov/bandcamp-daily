import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AlbumDetails, BucketId, Candidate } from '../bandcamp/types.ts';
import { BUCKETS } from '../profile/buckets.ts';
import type { BucketProfile, Profile } from '../profile/build.ts';
import type { ApproveState, CardEdit, PendingCard } from '../telegram/approve.ts';
import type { TelegramUpdate } from '../telegram/api.ts';
import type { Card } from '../telegram/card.ts';
import {
  editCard,
  hubTagsForBucket,
  loadConfig,
  runDaily,
  type DailyDeps,
  type DailyOptions,
} from './daily.ts';

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
  return { pending: [], feedbackTags: {}, seen: [], lastUpdateId: 0 };
}

interface FakeTelegramDeps {
  getUpdates: DailyDeps['telegram']['getUpdates'];
  sendCard: DailyDeps['telegram']['sendCard'];
  replaceCard: DailyDeps['telegram']['replaceCard'];
  deleteCard: DailyDeps['telegram']['deleteCard'];
  ack: DailyDeps['telegram']['ack'];
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
    replaceCard: async () => {},
    deleteCard: async () => {},
    ack: async () => {},
  };
}

const baseOptions: DailyOptions = {
  maxAgeDays: 7,
  maxFutureDays: 30,
  archivePoolLimit: 10,
  alternativesCount: 3,
  hubTagsPerBucket: 4,
  minTotal: 0,
  listenMinutes: 0,
};

test('runDaily: отправляет ровно одну карточку за заход', async () => {
  const profile = fakeProfile();
  const state = emptyState();
  const telegram = baseTelegram();

  const deps: DailyDeps = {
    fresh: {
      // Один свежий кандидат на хаб-тег — url кодирует сам тег, так что
      // фейку не нужно знать имена бакетов, только сам запрошенный тег.
      // Кандидаты набираются во всех четырёх бакетах, но уйти владельцу
      // обязан ровно один — лучший из всех разом.
      discover: async (opts) => [
        { itemId: 1, url: `https://x.test/album/${opts.tag}`, title: opts.tag, artist: 'A', location: null },
      ],
      bandReleases: async () => [],
      album: async (url) => album({ tags: [url.split('/').pop()!] }),
    },
    archive: { album: async () => null },
    fetchOwnedUrls: async () => [],
    fetchFollowSubdomains: async () => [],
    telegram,
    persistState: async () => {},
    now: () => new Date('2026-08-03'),
  };

  await runDaily(profile, [], state, deps, baseOptions);

  assert.equal(telegram.sentCards.length, 1);
  assert.equal(state.pending.length, 1);
  assert.ok(state.lastBucket, 'бакет пика запоминается для запрета на повтор');
});

test('runDaily: ниже порога не отправляет ничего и не трогает lastBucket', async () => {
  const profile = fakeProfile();
  const state = emptyState();
  state.lastBucket = 'crust';
  const telegram = baseTelegram();

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
    telegram,
    persistState: async () => {},
    now: () => new Date('2026-08-03'),
  };

  await runDaily(profile, [], state, deps, { ...baseOptions, minTotal: 99 });

  assert.equal(telegram.sentCards.length, 0);
  assert.equal(state.pending.length, 0);
  assert.equal(state.lastBucket, 'crust', 'молчаливый заход не сбрасывает запрет');
});

test('runDaily: кандидат с тегом из profile.hardRejectTags не отправляется владельцу ни основным пиком, ни запасным', async () => {
  // Прямая проверка сквозного провода profile.hardRejectTags -> pickBest ->
  // score() (см. вызов `pickBest` в daily.ts): для каждого хаб-тега discover
  // отдаёт три кандидата — два обычных и копию с довеском 'compilation'.
  // Обычные проходят скоринг (несут тег бакета), компиляция несёт тот же тег
  // (то есть матчится НЕ слабее), но должна быть убита hardRejectTags
  // целиком — ни как основной пик, ни как «другой кандидат» в запасе. Второй
  // обычный кандидат тут не для симметрии: без него у победителя не было бы
  // ни одной альтернативы, и проверка запаса стала бы пустой.
  const profile = fakeProfile();
  profile.hardRejectTags = ['compilation'];
  const state = emptyState();
  const telegram = baseTelegram();

  const deps: DailyDeps = {
    fresh: {
      discover: async (opts) => [
        { itemId: 1, url: `https://x.test/album/${opts.tag}`, title: opts.tag, artist: 'A', location: null },
        { itemId: 2, url: `https://x.test/album/${opts.tag}-b`, title: `${opts.tag} b`, artist: 'B', location: null },
        {
          itemId: 3,
          url: `https://x.test/album/${opts.tag}-comp`,
          title: `${opts.tag} comp`,
          artist: 'C',
          location: null,
        },
      ],
      bandReleases: async () => [],
      album: async (url) => {
        const isComp = url.endsWith('-comp');
        const tag = url.split('/').pop()!.replace(/-(comp|b)$/, '');
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

  const card = state.pending[0];
  assert.ok(card, 'некомпилированный кандидат был — карточка обязана уйти');
  assert.ok(
    !card.candidate.tags.includes('compilation'),
    'владельцу отправлена компиляция как основной пик',
  );
  assert.ok(card.alternatives.length > 0, 'запас «другой кандидат» должен быть непустым, иначе проверка ниже пуста');
  assert.ok(
    card.alternatives.every((alt) => !alt.tags.includes('compilation')),
    'компиляция лежит в запасе «другой кандидат»',
  );
});

test('runDaily: разбор нажатия (skip) во время дренажа backlog пишет в persistState ровно то, что произвёл handleUpdates', async () => {
  const profile = fakeProfile();
  const bucketId = BUCKETS[0]!.id;
  const candidate: Candidate = {
    itemId: 42,
    url: 'https://x.test/album/42',
    title: 'T',
    artist: 'A',
    label: null,
    // 'noise' — не опорный тег бакета, поэтому скип обязан оставить след в
    // feedbackTags (опорные из штрафа исключены, см. `handleSkip`).
    tags: [BUCKETS[0]!.seedTags[0]!, 'noise'],
    releasedAt: '2026-08-01',
    artUrl: null,
    alsoCollected: 0,
    origin: 'fresh',
  };
  const state: ApproveState = {
    pending: [{ bucket: bucketId, messageId: 500, hasPhoto: false, candidate, matchedTags: [], alternatives: [] }],
    feedbackTags: {},
    seen: [],
    lastUpdateId: 0,
  };

  const skipUpdate: TelegramUpdate = {
    update_id: 9,
    callback_query: { id: 'q1', data: `skip|${bucketId}|42`, message: { message_id: 500, chat: { id: 1 } } },
  };

  const persisted: ApproveState[] = [];
  const telegram = baseTelegram([[skipUpdate]]);

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
  assert.ok(state.seen.includes(candidate.url));
  assert.equal(state.feedbackTags.noise, 1);
  assert.ok(persisted.length > 0);
  // Последний персист обязан совпадать с реальным итоговым состоянием —
  // ровно то, что произвёл handleUpdates, а не устаревший снимок.
  assert.deepEqual(persisted[persisted.length - 1], JSON.parse(JSON.stringify(state)));
});

test('runDaily: опрос останавливается раньше срока, как только pending опустел', async () => {
  const profile = fakeProfile();
  const state = emptyState();

  let pollCalls = 0;
  // Карточка должна появиться ПО ХОДУ прогона, а не быть посажена в pending
  // заранее: всё, что осталось в pending с прошлого прогона, подчистка на
  // шаге 1b сносит до сбора кандидатов (см. `sweepStaleMessages`).
  //
  // Скип шлётся сразу за все четыре бакета, потому что тест не знает, чей
  // кандидат выиграет сквозной рейтинг; попадёт ровно один, остальные три
  // handleUpdates отбросит как «карточка уже обработана».
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
      replaceCard: async () => {},
      deleteCard: async () => {},
      ack: async () => {},
    },
    persistState: async () => {},
    now: () => new Date('2026-08-03'),
  };

  await runDaily(profile, [], state, deps, { ...baseOptions, listenMinutes: 0 });

  // Один вызов — дренаж backlog на шаге 1. Цикл опроса на шаге 4 не должен
  // был вызвать getUpdates ни разу: until уже в прошлом при listenMinutes=0.
  assert.equal(getUpdatesCalls, 1);
  // Посаженная в pending карточка — хвост прошлого прогона; подчистка на
  // шаге 1b сносит её до сбора кандидатов, а не оставляет висеть.
  assert.equal(state.pending.length, 0);
});

/** Непрожатая карточка прошлого захода — то, что подчистка обязана снести. */
function leftoverCard(messageId: number, url: string): PendingCard {
  return {
    bucket: BUCKETS[0]!.id,
    messageId,
    hasPhoto: false,
    candidate: {
      itemId: messageId,
      url,
      title: 'T',
      artist: 'A',
      label: null,
      tags: [],
      releasedAt: '2026-08-01',
      artUrl: null,
      alsoCollected: 0,
      origin: 'fresh',
    },
    matchedTags: [],
    alternatives: [],
  };
}

test('runDaily: подчистка сносит вчерашнюю карточку, помечая релиз показанным', async () => {
  const profile = fakeProfile();
  const card = leftoverCard(11, 'https://x.test/album/leftover');
  const state: ApproveState = { pending: [card], feedbackTags: {}, seen: [], lastUpdateId: 0 };

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

  assert.deepEqual(deleted, [11]);
  assert.equal(state.pending.length, 0);
  assert.ok(
    state.seen.includes(card.candidate.url),
    'непрожатая карточка считается показанной — иначе тот же релиз придёт завтра снова',
  );
});

test('runDaily: провал удаления одного хвоста не мешает снести остальные', async () => {
  const profile = fakeProfile();
  // Три карточки разом за один заход больше не отправляются, но подчистка
  // обходит ВЕСЬ pending, а не одну запись: в файле состояния их может
  // лежать сколько угодно — хвост старой схемы с пачкой карточек за прогон,
  // или заход, убитый до того, как успел разобрать нажатия.
  const state: ApproveState = {
    pending: [21, 22, 23].map((id) => leftoverCard(id, `https://x.test/album/${id}`)),
    feedbackTags: {},
    seen: [],
    lastUpdateId: 0,
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
  assert.equal(
    state.pending.length,
    0,
    'вчерашние хвосты забыты все разом, включая тот, что не удалился — повторять снос нечего',
  );
});

test('runDaily: без единого кандидата заход молчит, а не шлёт служебное «сегодня пусто»', async () => {
  const profile = fakeProfile();
  const state = emptyState();
  const telegram = baseTelegram();

  const deps: DailyDeps = {
    fresh: { discover: async () => [], bandReleases: async () => [], album: async () => null },
    archive: { album: async () => null },
    fetchOwnedUrls: async () => [],
    fetchFollowSubdomains: async () => [],
    telegram,
    persistState: async () => {},
    now: () => new Date('2026-08-03'),
  };

  await runDaily(profile, [], state, deps, baseOptions);

  assert.equal(telegram.sentCards.length, 0);
  assert.equal(state.pending.length, 0);
  assert.equal(state.lastBucket, undefined, 'пустой заход не ставит запрет ни на один бакет');
});
