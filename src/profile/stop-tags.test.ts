import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveStopTags } from './stop-tags.ts';

test('частый в хабе и отсутствующий у владельца тег становится стоп-тегом', () => {
  const stop = deriveStopTags({
    hubTagCounts: { deathcore: 12, 'death metal': 30, melodeath: 7 },
    ownedTags: new Set(['death metal', 'osdm']),
    minHubCount: 5,
  });
  assert.deepEqual(stop.sort(), ['deathcore', 'melodeath']);
});

test('тег из коллекции владельца стоп-тегом не станет никогда', () => {
  const stop = deriveStopTags({
    hubTagCounts: { osdm: 40 },
    ownedTags: new Set(['osdm']),
    minHubCount: 1,
  });
  assert.deepEqual(stop, []);
});

test('редкие в хабе теги не попадают в стоп-лист — это шум, а не жанр', () => {
  const stop = deriveStopTags({
    hubTagCounts: { 'случайное слово': 2 },
    ownedTags: new Set(),
    minHubCount: 5,
  });
  assert.deepEqual(stop, []);
});

test('стоп-лист обрезается лимитом и отсортирован по частоте', () => {
  const stop = deriveStopTags({
    hubTagCounts: { a: 100, b: 50, c: 10 },
    ownedTags: new Set(),
    minHubCount: 5,
    limit: 2,
  });
  assert.deepEqual(stop, ['a', 'b']);
});
