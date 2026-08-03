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

test('усечение большой чужой коллекции не искажает вес — знаменатель уже упёрся в размер владельца', async () => {
  // Овнер: 4 релиза (mineIds.size = 4). У соседа 20 пересечение — одни и те
  // же 2 релиза в обоих прогонах; разница только в том, сколько его
  // коллекции успели прочитать до обрыва лимитом страниц: 50 позиций или
  // гипотетически полные 5000. В обоих случаях theirs.length на порядки
  // больше mineIds.size, так что Math.min(theirs.length, mineIds.size) уже
  // равен mineIds.size независимо от того, где именно чужую коллекцию
  // оборвали — truncation здесь просто не долетает до знаменателя.
  const filler = (from: number, count: number) => Array.from({ length: count }, (_, i) => item(from + i));

  const weightForTheirsLength = async (theirsLength: number): Promise<number | undefined> => {
    const deps: NeighborDeps = {
      collectors: async () => [20],
      collectionOf: async () => [item(1), item(2), ...filler(1000, theirsLength - 2)],
    };
    const [neighbor] = await computeNeighbors(deps, {
      ownerFanId: 999,
      mine: [item(1), item(2), item(3), item(4)],
      seedCount: 4,
      candidateLimit: 10,
      neighborLimit: 10,
    });
    return neighbor?.weight;
  };

  assert.equal(await weightForTheirsLength(50), 0.5);
  assert.equal(await weightForTheirsLength(5000), 0.5);
});

test('родственная душа с маленькой коллекцией обгоняет всеядного с тем же overlap в огромной', async () => {
  // Оба соседа пересекаются с владельцем ровно по 50 релизам. У соседа 10
  // коллекция маленькая (60 позиций) — эти 50 общих релизов заметная её
  // часть, родственная душа. У соседа 20 коллекция огромная (1000 позиций)
  // — те же 50 общих релизов растворены среди остального: всеядный
  // коллекционер, чьи прочие покупки ни о чём не говорят. Мера близости
  // обязана различать их, а не считать одинаково близкими только потому,
  // что абсолютное число общих релизов совпало.
  const overlapping = Array.from({ length: 50 }, (_, i) => item(i + 1));
  const mine = Array.from({ length: 100 }, (_, i) => item(i + 1));

  const deps: NeighborDeps = {
    collectors: async () => [10, 20],
    collectionOf: async (fanId) =>
      fanId === 10
        ? [...overlapping, ...Array.from({ length: 10 }, (_, i) => item(2000 + i))]
        : [...overlapping, ...Array.from({ length: 950 }, (_, i) => item(3000 + i))],
  };

  const neighbors = await computeNeighbors(deps, {
    ownerFanId: 999,
    mine,
    seedCount: 100,
    candidateLimit: 10,
    neighborLimit: 10,
  });

  const kindred = neighbors.find((n) => n.fanId === 10);
  const omnivore = neighbors.find((n) => n.fanId === 20);
  assert.equal(kindred?.weight, 0.8333);
  assert.equal(omnivore?.weight, 0.5);
  assert.ok(kindred!.weight > omnivore!.weight);
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
