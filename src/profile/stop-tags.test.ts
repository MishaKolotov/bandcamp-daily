import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveStopTags } from './stop-tags.ts';

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
