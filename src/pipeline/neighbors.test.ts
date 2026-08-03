import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FanItem } from '../bandcamp/types.ts';
import { computeNeighbors, type NeighborDeps } from './neighbors.ts';

const item = (id: number): FanItem => ({
  itemId: id,
  bandId: id,
  title: `T${id}`,
  artist: `A${id}`,
  url: `https://x.test/album/${id}`,
  subdomain: 'x',
  alsoCollected: 0,
  addedAt: '2026-01-01',
  source: 'collection',
});

async function withCapturedConsole<T>(
  method: 'warn' | 'error',
  fn: () => Promise<T>,
): Promise<{ result: T; calls: unknown[][] }> {
  const original = console[method];
  const calls: unknown[][] = [];
  console[method] = (...args: unknown[]) => {
    calls.push(args);
  };
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    console[method] = original;
  }
}

test('сосед с большим пересечением получает больший вес', async () => {
  const deps: NeighborDeps = {
    collectors: async () => [10, 20],
    collectionOf: async (fanId) =>
      fanId === 10 ? [item(1), item(2), item(3)] : [item(1), item(99), item(98)],
  };
  const neighbors = await computeNeighbors(deps, {
    ownerFanId: 1,
    mine: [item(1), item(2), item(3)],
    seedCount: 3,
    candidateLimit: 10,
    neighborLimit: 10,
  });
  assert.equal(neighbors[0]?.fanId, 10);
  assert.ok(neighbors[0]!.weight > neighbors[1]!.weight);
});

test('сам владелец в соседи не попадает', async () => {
  const deps: NeighborDeps = {
    collectors: async () => [7566215],
    collectionOf: async () => [item(1)],
  };
  const neighbors = await computeNeighbors(deps, {
    ownerFanId: 7566215,
    mine: [item(1)],
    seedCount: 1,
    candidateLimit: 5,
    neighborLimit: 5,
  });
  assert.deepEqual(neighbors, []);
});

test('в соседе сохраняются его релизы, чтобы ежедневный запуск не ходил в сеть', async () => {
  const deps: NeighborDeps = {
    collectors: async () => [10],
    collectionOf: async () => [item(1), item(5)],
  };
  const [neighbor] = await computeNeighbors(deps, {
    ownerFanId: 1,
    mine: [item(1)],
    seedCount: 1,
    candidateLimit: 5,
    neighborLimit: 5,
  });
  assert.deepEqual(neighbor?.items.map((i) => i.itemId), [1, 5]);
});

test('соседи с нулевым пересечением отбрасываются', async () => {
  const deps: NeighborDeps = {
    collectors: async () => [10],
    collectionOf: async () => [item(77)],
  };
  const neighbors = await computeNeighbors(deps, {
    ownerFanId: 1,
    mine: [item(1)],
    seedCount: 1,
    candidateLimit: 5,
    neighborLimit: 5,
  });
  assert.deepEqual(neighbors, []);
});

test('вес — доля пересечения от СВОЕЙ коллекции, устойчивая к усечению чужой', async () => {
  // Овнер: 4 релиза. Сосед 10 отдаёт полную коллекцию (2 релиза, оба общие).
  // Сосед 20 отдаёт коллекцию, ОБРЕЗАННУЮ лимитом страниц: его настоящая
  // коллекция намного больше, но collectionOf вернул только 1 позицию,
  // которая совпадает с моей. Старая формула overlap/min(theirs, mine)
  // дала бы соседу 20 вес 1/1 = 1.0 — выше, чем у соседа 10 (2/2 = 1.0, тоже
  // максимум, но это совпадение); возьмём случай, где обрезка реально
  // завышает: сосед 20 вернул 1 релиз из своих (обрезано), он совпадает —
  // min(1, 4) = 1 → 1/1 = 1.0, притом что настоящее пересечение с его
  // полной коллекцией могло быть той же единицей из сотен позиций.
  // Знаменатель на основе mineIds.size (4) даёт соседу 20 вес 1/4 = 0.25 —
  // не зависящий от того, сколько страниц его коллекции удалось прочитать.
  const deps: NeighborDeps = {
    collectors: async () => [10, 20],
    collectionOf: async (fanId) => (fanId === 10 ? [item(1), item(2)] : [item(1)]),
  };
  const neighbors = await computeNeighbors(deps, {
    ownerFanId: 999,
    mine: [item(1), item(2), item(3), item(4)],
    seedCount: 4,
    candidateLimit: 10,
    neighborLimit: 10,
  });
  const n20 = neighbors.find((n) => n.fanId === 20);
  assert.equal(n20?.weight, 0.25);
});

test('мёртвый аккаунт не роняет весь прогон — остальные соседи сохраняются', async () => {
  const deps: NeighborDeps = {
    collectors: async () => [10, 20, 30],
    collectionOf: async (fanId) => {
      if (fanId === 20) throw new Error('403 Forbidden');
      return [item(1)];
    },
  };
  const { result: neighbors, calls } = await withCapturedConsole('warn', () =>
    computeNeighbors(deps, {
      ownerFanId: 1,
      mine: [item(1)],
      seedCount: 1,
      candidateLimit: 10,
      neighborLimit: 10,
    }),
  );
  assert.deepEqual(
    neighbors.map((n) => n.fanId).sort((a, b) => a - b),
    [10, 30],
  );
  assert.equal(calls.length, 1);
});

test('затравка берёт разреженную выборку по всей коллекции, а не только последние N', async () => {
  // mine отсортирован как отдаёт fetchFanItems — самые свежие позиции
  // первыми. Если бы seed'ы брались как mine.slice(0, seedCount), при
  // seedCount=2 на коллекции из 6 релизов это были бы item(1) и item(2) —
  // только самые недавние добавления. Разреженная выборка по всей длине
  // обязана взять что-то и из старой части коллекции тоже.
  const queried: number[] = [];
  const deps: NeighborDeps = {
    collectors: async (albumId) => {
      queried.push(albumId);
      return [];
    },
    collectionOf: async () => [],
  };
  await computeNeighbors(deps, {
    ownerFanId: 1,
    mine: [item(1), item(2), item(3), item(4), item(5), item(6)],
    seedCount: 2,
    candidateLimit: 10,
    neighborLimit: 10,
  });
  assert.deepEqual(queried, [1, 4]);
});
