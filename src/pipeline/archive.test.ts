import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AlbumDetails } from '../bandcamp/types.ts';
import type { Neighbor } from './neighbors.ts';
import { archiveCandidates } from './archive.ts';

const url = (id: number): string => `https://x.test/album/${id}`;

const neighbor = (fanId: number, weight: number, ids: number[]): Neighbor => ({
  fanId,
  weight,
  itemUrls: ids.map(url),
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
      exclude: new Set([url(1)]),
      limit: 10,
    },
  );
  assert.deepEqual(found.map((c) => c.url), [url(2)]);
  assert.equal(found[0]?.origin, 'archive');
});

test('itemId кандидата — детерминированный хеш URL, а не соседский item_id', async () => {
  // Neighbor.itemUrls хранит только URL (см. комментарий в neighbors.ts —
  // itemId соседского релиза больше не сохраняется в data/neighbors.json).
  // archiveCandidates обязана сама вывести стабильный itemId для
  // callback_data — тем же способом, каким это уже делается для релизов
  // без настоящего item_id в fresh.ts (см. `hashUrl` в `src/lib/hash.ts`):
  // ненулевой, детерминированный между вызовами, разный для разных URL.
  const found = await archiveCandidates(
    { album: async () => album },
    { neighbors: [neighbor(10, 1, [1, 2])], exclude: new Set(), limit: 10 },
  );
  const again = await archiveCandidates(
    { album: async () => album },
    { neighbors: [neighbor(10, 1, [1, 2])], exclude: new Set(), limit: 10 },
  );
  assert.notEqual(found[0]?.itemId, 0);
  assert.notEqual(found[0]?.itemId, found[1]?.itemId);
  assert.equal(found[0]?.itemId, again[0]?.itemId);
});

test('title/artist кандидата берутся со страницы релиза, а не из соседской коллекции', async () => {
  // Соседская коллекция в data/neighbors.json больше не хранит title/artist
  // (см. Neighbor.itemUrls) — единственный источник этих полей теперь
  // deps.album(url), вызываемый здесь же для каждого кандидата.
  const found = await archiveCandidates(
    { album: async () => ({ ...album, title: 'Со страницы релиза', artist: 'Реальный артист' }) },
    { neighbors: [neighbor(10, 1, [1])], exclude: new Set(), limit: 10 },
  );
  assert.equal(found[0]?.title, 'Со страницы релиза');
  assert.equal(found[0]?.artist, 'Реальный артист');
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
  assert.equal(found[0]?.url, url(2));
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
  assert.deepEqual(found.map((c) => c.url), [url(100), url(200)]);
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
  assert.deepEqual(found.map((c) => c.url), [url(200), url(100)]);
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

test('один и тот же релиз у двух соседей дедуплицируется по URL, а голоса сходятся в voteScore', async () => {
  // Оба соседа указывают на один и тот же URL — единственное, что теперь
  // хранится в Neighbor.itemUrls (см. комментарий там же). Дедуп обязан
  // идти по URL, а голоса — сходиться в voteScore: 1 + 0.25 * 0.5 = 1.125.
  const found = await archiveCandidates(
    { album: async () => album },
    {
      neighbors: [
        { fanId: 10, weight: 1, itemUrls: [url(1)] },
        { fanId: 11, weight: 0.5, itemUrls: [url(1)] },
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
    { album: async (albumUrl) => (albumUrl === url(1) ? null : album) },
    { neighbors: [neighbor(10, 1, [1, 2, 3])], exclude: new Set(), limit: 2 },
  );
  assert.deepEqual(found.map((c) => c.url), [url(2)]);
});
