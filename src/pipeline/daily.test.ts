import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AlbumDetails, BucketId } from '../bandcamp/types.ts';
import { BUCKETS } from '../profile/buckets.ts';
import type { BucketProfile, Profile } from '../profile/build.ts';
import type { PickerContext, PickRequest } from '../site/api.ts';
import {
  DEFAULT_SITE_URL,
  hubTagsForBucket,
  loadConfig,
  penaltyTagsFor,
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
// loadConfig
// ---------------------------------------------------------------------------

test('loadConfig: без PICKER_SECRET падает сразу и по имени переменной', () => {
  assert.throws(() => loadConfig({} as NodeJS.ProcessEnv), /PICKER_SECRET/);
});

test('loadConfig: SITE_URL необязателен и по умолчанию — свой сайт', () => {
  const config = loadConfig({ PICKER_SECRET: 's' } as NodeJS.ProcessEnv);
  assert.equal(config.siteUrl, DEFAULT_SITE_URL);
  assert.equal(config.pickerSecret, 's');
});

test('loadConfig: SITE_URL переопределяется — отладка против локального next dev', () => {
  const config = loadConfig({ PICKER_SECRET: 's', SITE_URL: 'http://localhost:3000' } as NodeJS.ProcessEnv);
  assert.equal(config.siteUrl, 'http://localhost:3000');
});

// ---------------------------------------------------------------------------
// penaltyTagsFor
// ---------------------------------------------------------------------------

test('penaltyTagsFor: опорный тег бакета не штрафуется — иначе бакет отбракует сам себя', () => {
  assert.deepEqual(penaltyTagsFor(['crust', 'stenchcore'], ['crust', 'd-beat']), ['stenchcore']);
});

test('penaltyTagsFor: сравнение каноническое — дефис не превращает опорный тег в штрафуемый', () => {
  assert.deepEqual(penaltyTagsFor(['d beat', 'dbeat'], ['d-beat']), []);
});

test('penaltyTagsFor: релиз, совпавший только опорными тегами, не даёт штрафовать ничего', () => {
  assert.deepEqual(penaltyTagsFor(['crust'], ['crust']), []);
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

/** Сайт за интерфейсом: помнит всё, что ему отдали, и отвечает заданным контекстом. */
function fakeSite(context: Partial<PickerContext> = {}) {
  const sent: PickRequest[] = [];
  return {
    sent,
    readContext: async () => ({ seen: [], feedbackTags: {}, lastBucket: null, ...context }),
    sendPick: async (pick: PickRequest) => {
      sent.push(pick);
      return { messageId: 1000 + sent.length };
    },
  };
}

const baseOptions: DailyOptions = {
  maxAgeDays: 7,
  maxFutureDays: 30,
  archivePoolLimit: 10,
  alternativesCount: 3,
  hubTagsPerBucket: 4,
  minTotal: 0,
};

/** Зависимости без сети: свежак/архив пустые, сайт подставляется вызывающим тестом. */
function baseDeps(site: DailyDeps['site']): DailyDeps {
  return {
    fresh: { discover: async () => [], bandReleases: async () => [], album: async () => null },
    archive: { album: async () => null },
    fetchOwnedUrls: async () => [],
    fetchFollowSubdomains: async () => [],
    site,
    now: () => new Date('2026-08-03'),
  };
}

/** Свежак, где каждый хаб-тег отдаёт по одному кандидату, несущему ровно этот тег. */
const oneCandidatePerTag: DailyDeps['fresh'] = {
  discover: async (opts) => [
    { itemId: 1, url: `https://x.test/album/${opts.tag}`, title: opts.tag, artist: 'A', location: null },
  ],
  bandReleases: async () => [],
  album: async (url) => album({ tags: [decodeURIComponent(url.split('/').pop()!)] }),
};

test('runDaily: отдаёт сайту ровно одного победителя за заход', async () => {
  // Кандидаты набираются во всех бакетах, но уйти обязан ровно один — лучший
  // из всех разом.
  const site = fakeSite();
  const deps: DailyDeps = { ...baseDeps(site), fresh: oneCandidatePerTag };

  await runDaily(fakeProfile(), [], deps, baseOptions);

  assert.equal(site.sent.length, 1);
  assert.ok(site.sent[0]?.candidate.url);
});

test('runDaily: имя жанра уходит человекочитаемым, а не идентификатором бакета', async () => {
  // Названия бакетов живут здесь и сюда же прокидываются: держать вторую копию
  // на сайте значило бы завести источник правды, который однажды разъедется.
  const site = fakeSite();
  const deps: DailyDeps = { ...baseDeps(site), fresh: oneCandidatePerTag };

  await runDaily(fakeProfile(), [], deps, baseOptions);

  const pick = site.sent[0]!;
  const bucket = BUCKETS.find((entry) => entry.id === pick.bucket)!;
  assert.equal(pick.bucketTitle, bucket.title);
  assert.notEqual(pick.bucketTitle, pick.bucket);
});

test('runDaily: в штрафах уезжают только не-опорные теги релиза', async () => {
  // Опорный тег несёт каждый релиз бакета по построению — штрафовать его по
  // «Не моё» значило бы за десяток отказов утопить бакет целиком.
  const bucket = BUCKETS[0]!;
  const seed = bucket.seedTags[0]!;
  const profile = fakeProfile();
  // Тег заведомо синтетический: 'stenchcore' и прочие правдоподобные
  // подсказки сами лежат в seedTags бакетов, и тест проверял бы пустоту.
  profile.buckets[bucket.id].tags = { [seed]: 0.5, 'not-a-seed-tag': 1 };

  const site = fakeSite();
  const deps: DailyDeps = {
    ...baseDeps(site),
    fresh: {
      discover: async (opts) =>
        opts.tag === seed
          ? [{ itemId: 1, url: 'https://x.test/album/only', title: 'T', artist: 'A', location: null }]
          : [],
      bandReleases: async () => [],
      album: async () => album({ tags: [seed, 'not-a-seed-tag'] }),
    },
  };

  await runDaily(profile, [], deps, baseOptions);

  const pick = site.sent[0]!;
  assert.ok(pick.candidate.tags.includes(seed), 'опорный тег у релиза есть — иначе проверка ниже пуста');
  assert.deepEqual(pick.penaltyTags, ['not-a-seed-tag']);
});

test('runDaily: ниже порога не ходит на сайт вовсе', async () => {
  const site = fakeSite({ lastBucket: 'crust' });
  const deps: DailyDeps = { ...baseDeps(site), fresh: oneCandidatePerTag };

  await runDaily(fakeProfile(), [], deps, { ...baseOptions, minTotal: 99 });

  assert.equal(site.sent.length, 0, 'молчаливый заход не должен дёргать сайт пустым запросом');
});

test('runDaily: показанное с сайта попадает в отбор и второй раз не предлагается', async () => {
  const bucket = BUCKETS[0]!;
  const seed = bucket.seedTags[0]!;
  const url = 'https://x.test/album/only';

  const site = fakeSite({ seen: [url] });
  const deps: DailyDeps = {
    ...baseDeps(site),
    fresh: {
      // Единственный кандидат на весь заход — и он уже показан.
      discover: async (opts) =>
        opts.tag === seed ? [{ itemId: 1, url, title: 'T', artist: 'A', location: null }] : [],
      bandReleases: async () => [],
      album: async () => album({ tags: [seed] }),
    },
  };

  await runDaily(fakeProfile(), [], deps, baseOptions);

  assert.equal(site.sent.length, 0);
});

test('runDaily: кандидат с тегом из profile.hardRejectTags не уходит ни основным пиком, ни запасным', async () => {
  // Прямая проверка сквозного провода profile.hardRejectTags -> pickBest ->
  // score(): на каждый хаб-тег discover отдаёт трёх кандидатов — двух обычных
  // и копию с довеском 'compilation'. Обычные проходят скоринг, компиляция
  // несёт тот же тег (то есть матчится НЕ слабее), но должна быть убита
  // целиком. Второй обычный кандидат тут не для симметрии: без него у
  // победителя не было бы ни одной альтернативы, и проверка запаса стала бы
  // пустой.
  const profile = fakeProfile();
  profile.hardRejectTags = ['compilation'];

  const site = fakeSite();
  const deps: DailyDeps = {
    ...baseDeps(site),
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
        const tag = decodeURIComponent(url.split('/').pop()!).replace(/-(comp|b)$/, '');
        return album({ tags: isComp ? [tag, 'compilation'] : [tag] });
      },
    },
  };

  await runDaily(profile, [], deps, baseOptions);

  const pick = site.sent[0];
  assert.ok(pick, 'некомпилированный кандидат был — пик обязан уйти');
  assert.ok(!pick.candidate.tags.includes('compilation'), 'владельцу отправлена компиляция как основной пик');
  assert.ok(pick.alternatives.length > 0, 'запас «другой» должен быть непустым, иначе проверка ниже пуста');
  assert.ok(
    pick.alternatives.every((alt) => !alt.candidate.tags.includes('compilation')),
    'компиляция лежит в запасе «другой»',
  );
});

test('runDaily: каждый вариант запаса несёт свой жанр и свои штрафные теги', async () => {
  // Запас сквозной по бакетам, поэтому имя жанра и вычитание опорных тегов
  // считаются по бакету САМОГО варианта. Возьми их у победителя — и карточка
  // после нажатия «Другой» подписалась бы чужим жанром, а «Не моё» оштрафовало
  // бы теги альбома, которого на экране уже нет.
  const site = fakeSite();
  const deps: DailyDeps = { ...baseDeps(site), fresh: oneCandidatePerTag };

  await runDaily(fakeProfile(), [], deps, baseOptions);

  const pick = site.sent[0]!;
  assert.ok(pick.alternatives.length > 0, 'запас пуст — проверять нечего');

  for (const alt of pick.alternatives) {
    const bucket = BUCKETS.find((entry) => entry.id === alt.bucket)!;
    assert.ok(bucket, `вариант ссылается на несуществующий бакет ${alt.bucket}`);
    assert.equal(alt.bucketTitle, bucket.title);
    for (const tag of alt.penaltyTags) {
      assert.ok(
        !bucket.seedTags.includes(tag),
        `опорный тег ${tag} бакета ${alt.bucket} попал в штрафы варианта`,
      );
    }
  }

  assert.ok(
    pick.alternatives.some((alt) => alt.bucket !== pick.bucket),
    'запас, целиком совпавший с бакетом победителя, не доказывает сквозной отбор',
  );
});

test('runDaily: запрет на повтор жанра снимается, если иначе заход промолчал бы', async () => {
  // Запрет снимается только состоявшимся пиком, а молчаливый заход last_bucket
  // не трогает. Значит без отката бот, у которого кандидаты выше порога есть
  // только в забаненном бакете, замолкает НАВСЕГДА — ни один следующий заход
  // это не расколдует. Повтор жанра — меньшее зло, чем вечная тишина.
  const onlyBucket = BUCKETS[0]!;
  const site = fakeSite({ lastBucket: onlyBucket.id });

  const deps: DailyDeps = {
    ...baseDeps(site),
    fresh: {
      // Кандидаты есть только под опорный тег забаненного бакета.
      discover: async (opts) =>
        opts.tag === onlyBucket.seedTags[0]
          ? [{ itemId: 1, url: 'https://x.test/album/only', title: 'T', artist: 'A', location: null }]
          : [],
      bandReleases: async () => [],
      album: async () => album({ tags: [onlyBucket.seedTags[0]!] }),
    },
  };

  await runDaily(fakeProfile(), [], deps, baseOptions);

  assert.equal(site.sent.length, 1, 'заход обязан прислать альбом, а не замолчать навсегда');
  assert.equal(site.sent[0]?.bucket, onlyBucket.id);
});

test('runDaily: жанр прошлого пика, которого больше нет в BUCKETS, ничего не запрещает', async () => {
  // В Neon лежит то, что записал прошлый заход. Переименованный или снятый
  // бакет не должен ни падать, ни запрещать несуществующее.
  const site = fakeSite({ lastBucket: 'sludge-that-never-existed' });
  const deps: DailyDeps = { ...baseDeps(site), fresh: oneCandidatePerTag };

  await runDaily(fakeProfile(), [], deps, baseOptions);

  assert.equal(site.sent.length, 1);
});

test('runDaily: без единого кандидата заход молчит, а не шлёт служебное «сегодня пусто»', async () => {
  const site = fakeSite();

  await runDaily(fakeProfile(), [], baseDeps(site), baseOptions);

  assert.equal(site.sent.length, 0);
});

test('runDaily: сорванный контекст роняет заход, а не превращается в отбор с чистого листа', async () => {
  // Пустой контекст вместо ошибки означал бы «владельцу ничего не показывали»
  // — и заход честно предложил бы то, что тот вчера скипнул.
  const site = {
    readContext: async () => {
      throw new Error('GET /api/picker/context — 500: boom');
    },
    sendPick: async () => ({ messageId: 1 }),
  };

  await assert.rejects(() => runDaily(fakeProfile(), [], baseDeps(site), baseOptions), /500/);
});
