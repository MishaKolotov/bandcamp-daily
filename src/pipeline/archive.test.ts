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

test('голос второго соседа за тот же релиз учитывается частично (демпфированный хвост) и задаёт порядок', async () => {
  // Релиз 2 набрал двух соседей (1 и 0.5), релиз 1 — только одного (1).
  // Доминирующий голос за оба релиза — 1, но у релиза 2 есть ещё и хвост:
  // 1 + 0.25 * 0.5 = 1.125 > 1 — он и выходит на первое место.
  const found = await archiveCandidates(
    { album: async () => album },
    {
      neighbors: [neighbor(10, 1, [1, 2]), neighbor(11, 0.5, [2])],
      exclude: new Set(),
      limit: 10,
    },
  );
  assert.equal(found[0]?.itemId, 2);
  assert.equal(found[0]?.neighborWeight, 1.125);
});

test('один сильный сосед обгоняет толпу слабых даже с большей raw-суммой их весов', async () => {
  // Релиз 200 набирает 20 голосов по 0.05 — сырая сумма 1.0, больше, чем
  // единственный голос 0.9 за релиз 100. Но по факту релиз 200 понравился
  // толпе едва пересекающихся людей, а релиз 100 — одному настоящему
  // близнецу по вкусу. voteScore обязан поставить 100 выше: его счёт — 0.9
  // (единственный голос, демпфировать нечего), счёт 200 —
  // 0.05 + 0.25 * (19 * 0.05) = 0.2875.
  const weakCrowd = Array.from({ length: 20 }, (_, i) => neighbor(100 + i, 0.05, [200]));
  const found = await archiveCandidates(
    { album: async () => album },
    {
      neighbors: [neighbor(1, 0.9, [100]), ...weakCrowd],
      exclude: new Set(),
      limit: 10,
    },
  );
  assert.deepEqual(found.map((c) => c.itemId), [100, 200]);
});

test('два сильных соседа всё равно обгоняют одного такого же сильного', async () => {
  // Релиз 200: два соседа с весом 0.9 каждый — счёт 0.9 + 0.25*0.9 = 1.125.
  // Релиз 100: один сосед с весом 0.9 — счёт 0.9. Демпфирование не стирает
  // genuine-совпадение нескольких близких соседей, оно просто не даёт толпе
  // далёких людей симулировать то же самое.
  const found = await archiveCandidates(
    { album: async () => album },
    {
      neighbors: [neighbor(1, 0.9, [100]), neighbor(2, 0.9, [200]), neighbor(3, 0.9, [200])],
      exclude: new Set(),
      limit: 10,
    },
  );
  assert.deepEqual(found.map((c) => c.itemId), [200, 100]);
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
  // между источниками. Дедуп обязан идти по URL, а голоса — сходиться в
  // voteScore: 1 + 0.25 * 0.5 = 1.125.
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
  assert.equal(found[0]?.neighborWeight, 1.125);
});

test('провал страницы альбома не восполняется кандидатом за пределами среза — контракт: без бэкафилла', async () => {
  // limit=2 отбирает по голосам только релизы 1 и 2 (у обоих один голос
  // веса 1, порядок — по вставке). Альбом релиза 1 не открылся — итог
  // короче на одну позицию, а не подтягивает релиз 3, который в срез по
  // options.limit вообще не попадал.
  const found = await archiveCandidates(
    { album: async (url) => (url === 'https://x.test/album/1' ? null : album) },
    { neighbors: [neighbor(10, 1, [1, 2, 3])], exclude: new Set(), limit: 2 },
  );
  assert.deepEqual(found.map((c) => c.itemId), [2]);
});
