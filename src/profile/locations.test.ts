import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLocationVocabulary,
  locationSegments,
  normalizeLocationToken,
  type LocationSample,
} from './locations.ts';

test('normalizeLocationToken: нижний регистр, диакритика снята, пробелы схлопнуты', () => {
  assert.equal(normalizeLocationToken('Montréal'), 'montreal');
  assert.equal(normalizeLocationToken('  Richmond  '), 'richmond');
  assert.equal(normalizeLocationToken('D.C.'), 'd c');
});

test('locationSegments: разбивает band_location по запятой и нормализует каждый сегмент', () => {
  assert.deepEqual(locationSegments('Richmond, Virginia'), ['richmond', 'virginia']);
  assert.deepEqual(locationSegments('Borlänge, Sweden'), ['borlange', 'sweden']);
});

test('locationSegments: голая страна/регион без города — один сегмент', () => {
  assert.deepEqual(locationSegments('Sweden'), ['sweden']);
  assert.deepEqual(locationSegments('California'), ['california']);
});

test('locationSegments: null и пустая строка не дают сегментов', () => {
  assert.deepEqual(locationSegments(null), []);
  assert.deepEqual(locationSegments(''), []);
});

function sample(artist: string, location: string | null): LocationSample {
  return { artist, location };
}

test('buildLocationVocabulary: сегмент от одного артиста не попадает в словарь по умолчанию', () => {
  const vocab = buildLocationVocabulary([sample('Ostraca', 'Richmond, Virginia')]);
  assert.deepEqual(vocab, []);
});

test('buildLocationVocabulary: сегмент от двух РАЗНЫХ артистов попадает в словарь', () => {
  const vocab = buildLocationVocabulary([
    sample('Ostraca', 'Richmond, Virginia'),
    sample('Iron Reagan', 'Richmond, Virginia'),
  ]);
  assert.deepEqual(vocab, ['richmond', 'virginia']);
});

test('buildLocationVocabulary: один и тот же артист, повторённый много раз, не набирает порог', () => {
  // Живой прогон показал, что топ-хаб отдаёт одного и того же исполнителя
  // до 4 раз (разные релизы) — это НЕ 4 независимых подтверждения места.
  const vocab = buildLocationVocabulary([
    sample('Ostraca', 'Richmond, Virginia'),
    sample('Ostraca', 'Richmond, Virginia'),
    sample('Ostraca', 'Richmond, Virginia'),
    sample('Ostraca', 'Richmond, Virginia'),
  ]);
  assert.deepEqual(vocab, []);
});

test('buildLocationVocabulary: имя артиста дедупится без учёта регистра', () => {
  const vocab = buildLocationVocabulary([
    sample('Ostraca', 'Richmond, Virginia'),
    sample('OSTRACA', 'Richmond, Virginia'),
  ]);
  assert.deepEqual(vocab, []);
});

test('buildLocationVocabulary: порог настраивается через minDistinctArtists', () => {
  const samples = [
    sample('A', 'Omaha, Nebraska'),
    sample('B', 'Omaha, Nebraska'),
  ];
  assert.deepEqual(buildLocationVocabulary(samples, { minDistinctArtists: 3 }), []);
  assert.deepEqual(buildLocationVocabulary(samples, { minDistinctArtists: 2 }).includes('omaha'), true);
});

test('buildLocationVocabulary: null/пустая локация и артист без имени не ломают подсчёт', () => {
  const vocab = buildLocationVocabulary([
    sample('A', null),
    sample('', 'Richmond, Virginia'),
    sample('B', 'Richmond, Virginia'),
    sample('C', 'Richmond, Virginia'),
  ]);
  assert.deepEqual(vocab, ['richmond', 'virginia']);
});

test('buildLocationVocabulary: результат отсортирован', () => {
  const vocab = buildLocationVocabulary([
    sample('A', 'Vienna, Austria'),
    sample('B', 'Vienna, Austria'),
    sample('C', 'Berlin, Germany'),
    sample('D', 'Berlin, Germany'),
  ]);
  assert.deepEqual(vocab, [...vocab].sort());
  assert.deepEqual(vocab, ['austria', 'berlin', 'germany', 'vienna']);
});
