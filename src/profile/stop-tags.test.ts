import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveStopTags, deriveStopTagsForBucket } from './stop-tags.ts';

test('частый в хабе и отсутствующий у владельца тег становится стоп-тегом', () => {
  const stop = deriveStopTags({
    hubTagCounts: { deathcore: 12, 'death metal': 30, melodeath: 7 },
    ownedTagCounts: { 'death metal': 40, osdm: 12 },
    seedTags: [],
    minHubCount: 5,
    releasesSampled: 25,
  });
  assert.deepEqual(stop.sort(), ['deathcore', 'melodeath']);
});

test('тег, которым владелец владеет по-настоящему (много релизов), стоп-тегом не станет никогда', () => {
  const stop = deriveStopTags({
    hubTagCounts: { osdm: 40 },
    ownedTagCounts: { osdm: 40 },
    seedTags: [],
    minHubCount: 1,
    releasesSampled: 40,
  });
  assert.deepEqual(stop, []);
});

test('тег на ЕДИНСТВЕННОМ релизе владельца не иммунизирует стоп-тег — это шум, а не вкус', () => {
  // Прямое воспроизведение дефекта: раньше ЛЮБОЕ вхождение (в т.ч. один
  // залётный релиз вне всех бакетов) блокировало тег навсегда, поэтому
  // стоп-листы были пустыми на любой достаточно широкой коллекции. Тег
  // hub-частый (30 >= порога) и у владельца встречается ровно один раз —
  // при пороге по умолчанию (2) это НЕ считается владением.
  const stop = deriveStopTags({
    hubTagCounts: { deathcore: 30 },
    ownedTagCounts: { deathcore: 1 },
    seedTags: [],
    minHubCount: 5,
    releasesSampled: 30,
  });
  assert.deepEqual(stop, ['deathcore']);
});

test('тег ровно на пороге minOwnedCount уже считается владением', () => {
  const stop = deriveStopTags({
    hubTagCounts: { deathcore: 30 },
    ownedTagCounts: { deathcore: 2 },
    seedTags: [],
    minHubCount: 5,
    releasesSampled: 30,
  });
  assert.deepEqual(stop, []);
});

test('minOwnedCount настраивается вызывающим кодом', () => {
  const input = {
    hubTagCounts: { deathcore: 30 },
    ownedTagCounts: { deathcore: 2 },
    seedTags: [],
    minHubCount: 5,
    releasesSampled: 30,
  };
  assert.deepEqual(deriveStopTags({ ...input, minOwnedCount: 3 }), ['deathcore']);
  assert.deepEqual(deriveStopTags({ ...input, minOwnedCount: 2 }), []);
});

test('редкие в хабе теги не попадают в стоп-лист — это шум, а не жанр', () => {
  const stop = deriveStopTags({
    hubTagCounts: { 'случайное слово': 2 },
    ownedTagCounts: {},
    seedTags: [],
    minHubCount: 5,
    releasesSampled: 10,
  });
  assert.deepEqual(stop, []);
});

test('стоп-лист обрезается лимитом и отсортирован по частоте', () => {
  const stop = deriveStopTags({
    hubTagCounts: { a: 100, b: 50, c: 10 },
    ownedTagCounts: {},
    seedTags: [],
    minHubCount: 5,
    releasesSampled: 50,
    limit: 2,
  });
  assert.deepEqual(stop, ['a', 'b']);
});

test('seed-тег своего бакета в стоп-лист не попадает, даже если частый и не куплен', () => {
  const stop = deriveStopTags({
    hubTagCounts: { powerviolence: 20, grindcore: 15 },
    ownedTagCounts: {},
    seedTags: ['powerviolence'],
    minHubCount: 5,
    releasesSampled: 50,
  });
  assert.deepEqual(stop, ['grindcore']);
});

test('тег другого бакета (не входящий в переданные seed-теги) стоп-тегом становится', () => {
  const stop = deriveStopTags({
    hubTagCounts: { 'd-beat': 20 },
    ownedTagCounts: {},
    seedTags: ['osdm', 'death metal'],
    minHubCount: 5,
    releasesSampled: 50,
  });
  assert.deepEqual(stop, ['d-beat']);
});

test('регистр не имеет значения: тег владельца в другом регистре всё равно подавляет стоп-тег', () => {
  const stop = deriveStopTags({
    hubTagCounts: { Deathcore: 20 },
    ownedTagCounts: { deathcore: 10 },
    seedTags: [],
    minHubCount: 5,
    releasesSampled: 50,
  });
  assert.deepEqual(stop, []);
});

test('регистр владельца не мешает суммированию: разные регистры одного тега складываются в один счётчик', () => {
  const stop = deriveStopTags({
    hubTagCounts: { Deathcore: 20 },
    ownedTagCounts: { deathcore: 1, Deathcore: 1 },
    seedTags: [],
    minHubCount: 5,
    releasesSampled: 50,
  });
  assert.deepEqual(stop, []);
});

test('регистр не имеет значения: seed-тег в другом регистре всё равно исключается', () => {
  const stop = deriveStopTags({
    hubTagCounts: { Powerviolence: 20 },
    ownedTagCounts: {},
    seedTags: ['powerviolence'],
    minHubCount: 5,
    releasesSampled: 50,
  });
  assert.deepEqual(stop, []);
});

test('тег, очищающий абсолютный пол, но не набирающий долю выборки, исключается', () => {
  const stop = deriveStopTags({
    hubTagCounts: { 'niche-tag': 6 },
    ownedTagCounts: {},
    seedTags: [],
    minHubCount: 5,
    releasesSampled: 100,
  });
  assert.deepEqual(stop, []);
});

test('тот же счётчик при меньшей выборке набирает долю и попадает в стоп-лист', () => {
  const stop = deriveStopTags({
    hubTagCounts: { 'niche-tag': 6 },
    ownedTagCounts: {},
    seedTags: [],
    minHubCount: 5,
    releasesSampled: 20,
  });
  assert.deepEqual(stop, ['niche-tag']);
});

test('дилюция: написания хаб-тега пулятся по суммарному счёту, а не проверяются порогом по отдельности', () => {
  // Без пулинга ни одно из трёх написаний не набирает порог по отдельности
  // (6, 5, 4 — все ниже порога 10), и стоп-тег молча пропадает целиком —
  // тот же класс бага, что дилюция весов профиля в build.ts, только на
  // стороне антипрофиля.
  const stop = deriveStopTags({
    hubTagCounts: { 'crust punk': 6, crustpunk: 5, 'crust-punk': 4 },
    ownedTagCounts: {},
    seedTags: [],
    minHubCount: 5,
    minHubShare: 0.2,
    releasesSampled: 50, // порог = max(5, 0.2*50=10) = 10
  });
  assert.deepEqual(stop, ['crust punk'], 'суммарный счёт 15 проходит порог, самое частое написание (6) — display');
});

test('дилюция: владение суммируется по написаниям так же, как и хаб-счёт', () => {
  // Хозяин купил тег под двумя написаниями (1 + 1 = 2) — это уже владение
  // (порог по умолчанию 2), даже если ни одно написание по отдельности не
  // достигает порога.
  const stop = deriveStopTags({
    hubTagCounts: { 'crust punk': 20 },
    ownedTagCounts: { 'crust-punk': 1, crustpunk: 1 },
    seedTags: [],
    minHubCount: 5,
    releasesSampled: 50,
  });
  assert.deepEqual(stop, []);
});

test('seed-тег другого написания всё равно исключает канонически совпадающий хаб-тег', () => {
  const stop = deriveStopTags({
    hubTagCounts: { crustpunk: 20 },
    ownedTagCounts: {},
    seedTags: ['crust-punk'],
    minHubCount: 5,
    releasesSampled: 50,
  });
  assert.deepEqual(stop, []);
});

test('порог по доле выборки: ровно на границе — включён, на единицу ниже — нет', () => {
  const stop = deriveStopTags({
    hubTagCounts: { exact: 10, below: 9 },
    ownedTagCounts: {},
    seedTags: [],
    minHubCount: 5,
    minHubShare: 0.2,
    releasesSampled: 50,
  });
  assert.deepEqual(stop, ['exact']);
});

test('тег из словаря мест не становится стоп-тегом, даже если хаб-частый и невладеемый', () => {
  // Прямое воспроизведение живого бага (2026-08): 'amadora' — город в
  // Португалии, хаб-частый (12 из 60) и невладеемый ровно так же, как
  // настоящий соседний поджанр death metal — без словаря мест он попал бы в
  // стоп-лист и штрафовал бы каждый релиз из этого города вне зависимости
  // от жанра.
  const stop = deriveStopTags({
    hubTagCounts: { amadora: 12, deathcore: 12 },
    ownedTagCounts: {},
    seedTags: [],
    minHubCount: 5,
    minHubShare: 0.2,
    releasesSampled: 60,
    locationVocabulary: new Set(['amadora']),
  });
  assert.deepEqual(stop, ['deathcore']);
});

test('без переданного словаря мест поведение не меняется — контроль на предыдущий тест', () => {
  const stop = deriveStopTags({
    hubTagCounts: { amadora: 12, deathcore: 12 },
    ownedTagCounts: {},
    seedTags: [],
    minHubCount: 5,
    minHubShare: 0.2,
    releasesSampled: 60,
  });
  assert.deepEqual(stop.sort(), ['amadora', 'deathcore']);
});

test('словарь мест сравнивается по каноническому тегу, не по точной строке', () => {
  const stop = deriveStopTags({
    hubTagCounts: { 'new-york': 12 },
    ownedTagCounts: {},
    seedTags: [],
    minHubCount: 5,
    minHubShare: 0.2,
    releasesSampled: 60,
    locationVocabulary: new Set(['new york']),
  });
  assert.deepEqual(stop, []);
});

// === deriveStopTagsForBucket: хабы бакета судятся по отдельности, не пулом ===

test('тег, сосредоточенный в одном хабе, проходит per-hub порог, хотя пул трёх хабов его бы не пропустил', () => {
  // Тот же класс числа, что и в живом прогоне: пороговая доля 0.2. Пул из
  // трёх хабов по 60 (180 сэмплов) требует 36 — 'brutal death metal' с 27
  // не проходит пул. По отдельности каждый хаб судится своим порогом
  // (0.2 * 60 = 12), и 27 в ОДНОМ хабе легко его берёт.
  const stop = deriveStopTagsForBucket({
    hubs: [
      { hubTagCounts: { 'brutal death metal': 27 }, releasesSampled: 60 },
      { hubTagCounts: {}, releasesSampled: 60 },
      { hubTagCounts: {}, releasesSampled: 60 },
    ],
    ownedTagCounts: {},
    seedTags: [],
  });
  assert.deepEqual(stop, ['brutal death metal']);
});

test('контроль: та же выборка, посчитанная старым способом (один пул на 180), стоп-тег теряет', () => {
  // Демонстрирует именно тот баг, который чинит deriveStopTagsForBucket:
  // тот же вход, но пулом (как делал bin/build-profile.ts до этой задачи) —
  // 27 из 180 не дотягивает до 36.
  const stop = deriveStopTags({
    hubTagCounts: { 'brutal death metal': 27 },
    ownedTagCounts: {},
    seedTags: [],
    releasesSampled: 180,
  });
  assert.deepEqual(stop, []);
});

test('тег ровно на пороге ОДНОГО хаба (12 из 60) уже проходит', () => {
  const stop = deriveStopTagsForBucket({
    hubs: [
      { hubTagCounts: { 'blackened death metal': 12 }, releasesSampled: 60 },
      { hubTagCounts: {}, releasesSampled: 60 },
    ],
    ownedTagCounts: {},
    seedTags: [],
  });
  assert.deepEqual(stop, ['blackened death metal']);
});

test('владение всё ещё вырезает тег, даже если он частый сразу в нескольких хабах бакета', () => {
  const stop = deriveStopTagsForBucket({
    hubs: [
      { hubTagCounts: { metal: 40 }, releasesSampled: 60 },
      { hubTagCounts: { metal: 35 }, releasesSampled: 60 },
      { hubTagCounts: { metal: 38 }, releasesSampled: 60 },
    ],
    ownedTagCounts: { metal: 73 },
    seedTags: [],
  });
  assert.deepEqual(stop, []);
});

test('seed-тег бакета не попадает в объединённый стоп-лист, даже если хаб-частый в нескольких хабах', () => {
  const stop = deriveStopTagsForBucket({
    hubs: [
      { hubTagCounts: { 'death metal': 60 }, releasesSampled: 60 },
      { hubTagCounts: { 'death metal': 55 }, releasesSampled: 60 },
    ],
    ownedTagCounts: {},
    seedTags: ['death metal'],
  });
  assert.deepEqual(stop, []);
});

test('тег, прошедший стоп-порог в двух хабах сразу, попадает в объединение один раз', () => {
  const stop = deriveStopTagsForBucket({
    hubs: [
      { hubTagCounts: { deathcore: 20 }, releasesSampled: 60 },
      { hubTagCounts: { deathcore: 15 }, releasesSampled: 60 },
    ],
    ownedTagCounts: {},
    seedTags: [],
  });
  assert.deepEqual(stop, ['deathcore']);
});

test('locationVocabulary в deriveStopTagsForBucket режет место, даже если оно проходит per-hub порог', () => {
  const stop = deriveStopTagsForBucket({
    hubs: [
      { hubTagCounts: { amadora: 12, deathcore: 12 }, releasesSampled: 60 },
      { hubTagCounts: {}, releasesSampled: 60 },
    ],
    ownedTagCounts: {},
    seedTags: [],
    locationVocabulary: new Set(['amadora']),
  });
  assert.deepEqual(stop, ['deathcore']);
});

test('общий limit применяется один раз к объединённому списку, а не к каждому хабу отдельно', () => {
  const stop = deriveStopTagsForBucket({
    hubs: [
      { hubTagCounts: { a: 30, b: 25 }, releasesSampled: 60 },
      { hubTagCounts: { c: 20 }, releasesSampled: 60 },
    ],
    ownedTagCounts: {},
    seedTags: [],
    minHubCount: 5,
    limit: 2,
  });
  assert.deepEqual(stop, ['a', 'b']);
});

test('пустой список хабов даёт пустой стоп-лист, а не падение', () => {
  const stop = deriveStopTagsForBucket({
    hubs: [],
    ownedTagCounts: {},
    seedTags: [],
  });
  assert.deepEqual(stop, []);
});

test('регрессия: реальная арифметика death-metal (отчёт по задаче) — узкие поджанры проходят, зонтичные, seed и места нет', () => {
  // Воспроизводит ровно диагностированный живой сценарий: три хаб-тега
  // бакета death-metal ('death metal', 'old school death metal',
  // 'death-doom'), каждый по ~60 сэмплов. Узкие поджанровые теги
  // (technical/blackened death metal) сосредоточены практически целиком в
  // одном хабе (типично для Discover — они соседствуют именно с общим
  // 'death metal', а не с 'death-doom'), зонтичные теги ('metal', 'black
  // metal') хаб-частые ВЕЗДЕ, но владелец их реально держит, а 'amadora' —
  // гео-шум, отсекаемый словарём мест.
  //
  // 'brutal death metal' здесь намеренно ТОЖЕ хаб-частый и невладеемый
  // (как в живом отчёте), но в отличие от technical/blackened он уже
  // является SEED-тегом бакета death-metal (см. buckets.ts) — и обязан
  // остаться исключённым по этой причине, а не стать стоп-тегом: seed-тег
  // своего же бакета в его стоп-лист не попадает никогда, независимо от
  // фикса порога (см. `deriveStopTags`). Более ранняя версия этого теста
  // ошибочно ожидала его в стоп-листе, скопировав числа из диагностики
  // задачи без проверки buckets.ts — реальный прогон `npm test` эту
  // ошибку поймал.
  const seedTags = [
    'death metal',
    'osdm',
    'old school death metal',
    'death-doom',
    'brutal death metal',
  ];
  const ownedTagCounts = {
    metal: 73,
    'death metal': 20,
    'old school death metal': 3,
    'death-doom': 1,
    'black metal': 59,
    osdm: 5,
  };

  const stop = deriveStopTagsForBucket({
    hubs: [
      {
        // хаб 'death metal'
        hubTagCounts: {
          metal: 58,
          'death metal': 60,
          'brutal death metal': 20,
          'technical death metal': 14,
          'black metal': 15,
        },
        releasesSampled: 60,
      },
      {
        // хаб 'old school death metal'
        hubTagCounts: {
          metal: 57,
          'old school death metal': 60,
          osdm: 17,
          'brutal death metal': 7,
          'technical death metal': 2,
          amadora: 12,
        },
        releasesSampled: 60,
      },
      {
        // хаб 'death-doom'
        hubTagCounts: {
          metal: 59,
          'death-doom': 60,
          'blackened death metal': 12,
          'black metal': 13,
        },
        releasesSampled: 60,
      },
    ],
    ownedTagCounts,
    seedTags,
    locationVocabulary: new Set(['amadora']),
  });

  assert.deepEqual(
    stop.sort(),
    ['blackened death metal', 'technical death metal'].sort(),
    `ожидали ровно два узких поджанра, получили: ${stop.join(', ') || '(пусто)'}`,
  );
  assert.ok(!stop.includes('metal'), 'зонтичный тег, которым владелец реально владеет, не должен стать стоп-тегом');
  assert.ok(!stop.includes('death metal'), 'seed-тег своего же бакета не должен стать стоп-тегом');
  assert.ok(!stop.includes('old school death metal'), 'seed-тег своего же бакета не должен стать стоп-тегом');
  assert.ok(!stop.includes('black metal'), 'зонтичный тег, которым владелец реально владеет, не должен стать стоп-тегом');
  assert.ok(
    !stop.includes('brutal death metal'),
    'brutal death metal — seed-тег бакета death-metal (см. buckets.ts), поэтому не может стать его же стоп-тегом, даже хаб-частый и невладеемый',
  );
  assert.ok(!stop.includes('amadora'), 'город не должен становиться стоп-тегом');
});
