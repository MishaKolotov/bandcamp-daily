import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveStopTags } from './stop-tags.ts';

test('частый в хабе и отсутствующий у владельца тег становится стоп-тегом', () => {
  const stop = deriveStopTags({
    hubTagCounts: { deathcore: 12, 'death metal': 30, melodeath: 7 },
    ownedTags: new Set(['death metal', 'osdm']),
    seedTags: [],
    minHubCount: 5,
  });
  assert.deepEqual(stop.sort(), ['deathcore', 'melodeath']);
});

test('тег из коллекции владельца стоп-тегом не станет никогда', () => {
  const stop = deriveStopTags({
    hubTagCounts: { osdm: 40 },
    ownedTags: new Set(['osdm']),
    seedTags: [],
    minHubCount: 1,
  });
  assert.deepEqual(stop, []);
});

test('редкие в хабе теги не попадают в стоп-лист — это шум, а не жанр', () => {
  const stop = deriveStopTags({
    hubTagCounts: { 'случайное слово': 2 },
    ownedTags: new Set(),
    seedTags: [],
    minHubCount: 5,
  });
  assert.deepEqual(stop, []);
});

test('стоп-лист обрезается лимитом и отсортирован по частоте', () => {
  const stop = deriveStopTags({
    hubTagCounts: { a: 100, b: 50, c: 10 },
    ownedTags: new Set(),
    seedTags: [],
    minHubCount: 5,
    limit: 2,
  });
  assert.deepEqual(stop, ['a', 'b']);
});

test('seed-тег своего бакета в стоп-лист не попадает, даже если частый и не куплен', () => {
  const stop = deriveStopTags({
    hubTagCounts: { powerviolence: 20, grindcore: 15 },
    ownedTags: new Set(),
    seedTags: ['powerviolence'],
    minHubCount: 5,
  });
  assert.deepEqual(stop, ['grindcore']);
});

test('тег другого бакета (не входящий в переданные seed-теги) стоп-тегом становится', () => {
  const stop = deriveStopTags({
    hubTagCounts: { 'd-beat': 20 },
    ownedTags: new Set(),
    seedTags: ['osdm', 'death metal'],
    minHubCount: 5,
  });
  assert.deepEqual(stop, ['d-beat']);
});

test('регистр не имеет значения: тег владельца в другом регистре всё равно подавляет стоп-тег', () => {
  const stop = deriveStopTags({
    hubTagCounts: { Deathcore: 20 },
    ownedTags: new Set(['deathcore']),
    seedTags: [],
    minHubCount: 5,
  });
  assert.deepEqual(stop, []);
});

test('регистр не имеет значения: seed-тег в другом регистре всё равно исключается', () => {
  const stop = deriveStopTags({
    hubTagCounts: { Powerviolence: 20 },
    ownedTags: new Set(),
    seedTags: ['powerviolence'],
    minHubCount: 5,
  });
  assert.deepEqual(stop, []);
});
