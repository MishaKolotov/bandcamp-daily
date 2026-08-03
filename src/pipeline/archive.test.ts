import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AlbumDetails } from '../bandcamp/types.ts';
import { archiveCandidates } from './archive.ts';

const neighbor = (fanId: number, weight: number, ids: number[]) => ({
  fanId,
  weight,
  items: ids.map((id) => ({
    itemId: id,
    url: `https://x.test/album/${id}`,
    title: `T${id}`,
    artist: `A${id}`,
  })),
});

const album: AlbumDetails = {
  title: 'T',
  artist: 'A',
  label: 'L',
  tags: ['crust'],
  releasedAt: '2015-01-01',
  artUrl: null,
};

test('релизы соседей, которых нет у владельца, становятся кандидатами', async () => {
  // exclude ключуется по URL, а не по itemId (см. "Решения, принятые по
  // ходу реализации" в плане, пункт 1): itemId ненадёжен как ключ между
  // источниками, URL — единственный стабильный.
  const found = await archiveCandidates(
    { album: async () => album },
    {
      neighbors: [neighbor(10, 1, [1, 2])],
      exclude: new Set(['https://x.test/album/1']),
      limit: 10,
    },
  );
  assert.deepEqual(found.map((c) => c.itemId), [2]);
  assert.equal(found[0]?.origin, 'archive');
});

test('вес голосов соседей суммируется и задаёт порядок', async () => {
  const found = await archiveCandidates(
    { album: async () => album },
    {
      neighbors: [neighbor(10, 1, [1, 2]), neighbor(11, 0.5, [2])],
      exclude: new Set(),
      limit: 10,
    },
  );
  assert.equal(found[0]?.itemId, 2);
  assert.equal(found[0]?.neighborWeight, 1.5);
});

test('лимит ограничивает число походов за страницами релизов', async () => {
  let calls = 0;
  const found = await archiveCandidates(
    {
      album: async () => {
        calls += 1;
        return album;
      },
    },
    { neighbors: [neighbor(10, 1, [1, 2, 3, 4, 5])], exclude: new Set(), limit: 2 },
  );
  assert.equal(calls, 2);
  assert.equal(found.length, 2);
});

test('один и тот же релиз у двух соседей с разным itemId дедуплицируется по URL', async () => {
  // Оба источника указывают на один и тот же релиз (тот же URL), но с
  // разными itemId — ситуация, которую decisions.md описывает как обычную
  // между источниками. Дедуп и суммирование весов обязаны идти по URL.
  const found = await archiveCandidates(
    { album: async () => album },
    {
      neighbors: [
        { fanId: 10, weight: 1, items: [{ itemId: 111, url: 'https://x.test/album/1', title: 'T1', artist: 'A1' }] },
        { fanId: 11, weight: 0.5, items: [{ itemId: 222, url: 'https://x.test/album/1', title: 'T1', artist: 'A1' }] },
      ],
      exclude: new Set(),
      limit: 10,
    },
  );
  assert.equal(found.length, 1);
  assert.equal(found[0]?.neighborWeight, 1.5);
});
