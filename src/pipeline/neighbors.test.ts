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
    minCollectionSize: 0,
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
    minCollectionSize: 0,
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
    minCollectionSize: 0,
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
    minCollectionSize: 0,
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
      minCollectionSize: 0,
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
    minCollectionSize: 0,
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
      minCollectionSize: 0,
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
    minCollectionSize: 0,
  });
  assert.deepEqual(queried, [1, 4]);
});

test('candidateLimit ограничивает поход в чужие коллекции только самыми частыми кандидатами', async () => {
  // Три семени (item 1, 2, 3), каждое отдаёт свой список коллекционеров.
  // Фанат 10 встречается во всех трёх семенах (счёт 3), 20 — в двух
  // (счёт 2), 30 — в одном (счёт 1). candidateLimit=2 обязан ограничить
  // deps.collectionOf ровно двумя вызовами — за 10 и 20, самыми частыми;
  // за 30, с наименьшим счётом, коллекция вообще не запрашивается. Это
  // единственный рычаг стоимости недельного прогона — сеть здесь дороже
  // всего.
  const calls: number[] = [];
  const deps: NeighborDeps = {
    collectors: async (albumId) => {
      if (albumId === 1) return [10, 20, 30];
      if (albumId === 2) return [10, 20];
      return [10];
    },
    collectionOf: async (fanId) => {
      calls.push(fanId);
      return [];
    },
  };
  await computeNeighbors(deps, {
    ownerFanId: 999,
    mine: [item(1), item(2), item(3)],
    seedCount: 3,
    candidateLimit: 2,
    neighborLimit: 10,
    minCollectionSize: 0,
  });
  assert.deepEqual(calls, [10, 20]);
});

test('neighborLimit обрезает итоговый список после сортировки по весу', async () => {
  // Три фаната проходят порог пересечения с разными весами: 10 — 1.0
  // (вся его коллекция совпадает с моей), 20 — 2/3 ≈ 0.6667 (совпадение
  // плюс один посторонний релиз), 30 — 0.25 (одно совпадение среди
  // четырёх посторонних). neighborLimit=2 должен оставить только два
  // самых весомых — 10 и 20, — а не просто первые два по порядку обхода.
  const deps: NeighborDeps = {
    collectors: async () => [10, 20, 30],
    collectionOf: async (fanId) => {
      if (fanId === 10) return [item(1), item(2), item(3), item(4)];
      if (fanId === 20) return [item(1), item(2), item(99)];
      return [item(1), item(98), item(97), item(96), item(95)];
    },
  };
  const neighbors = await computeNeighbors(deps, {
    ownerFanId: 999,
    mine: [item(1), item(2), item(3), item(4)],
    seedCount: 4,
    candidateLimit: 10,
    neighborLimit: 2,
    minCollectionSize: 0,
  });
  assert.deepEqual(neighbors.map((n) => n.fanId), [10, 20]);
});

test('minCollectionSize отбрасывает соседа с маленькой коллекцией, даже если пересечение есть', async () => {
  const deps: NeighborDeps = {
    collectors: async () => [10],
    collectionOf: async () => [item(1), item(2)], // theirs.length = 2
  };
  const neighbors = await computeNeighbors(deps, {
    ownerFanId: 999,
    mine: [item(1)],
    seedCount: 1,
    candidateLimit: 5,
    neighborLimit: 5,
    minCollectionSize: 3,
  });
  assert.deepEqual(neighbors, []);
});

test('коллекция ровно из minCollectionSize позиций проходит порог (включительно)', async () => {
  const filler = (from: number, count: number) => Array.from({ length: count }, (_, i) => item(from + i));
  const deps: NeighborDeps = {
    collectors: async () => [10],
    collectionOf: async () => [item(1), ...filler(1000, 2)], // theirs.length = 3
  };
  const neighbors = await computeNeighbors(deps, {
    ownerFanId: 999,
    mine: [item(1)],
    seedCount: 1,
    candidateLimit: 5,
    neighborLimit: 5,
    minCollectionSize: 3,
  });
  assert.deepEqual(
    neighbors.map((n) => n.fanId),
    [10],
  );
});

test('порог убирает шумовой топ-результат: крошечная коллекция с двумя общими релизами больше не обгоняет настоящее совпадение', async () => {
  // Форма повторяет боевой прогон, вскрывший баг: у владельца 223 релиза
  // (mineIds.size = 223 — как в проде, это важно: иначе знаменатель
  // «настоящего» совпадения тоже упёрся бы в размер mine и картина бы не
  // повторилась). Сосед 10 владеет всего 11 релизами, 2 из них общие с
  // владельцем — 2/11 ≈ 0.18, вес выше, чем у любого настоящего совпадения,
  // чисто из-за крошечного знаменателя. Сосед 20 владеет 200 релизами, 20
  // из них общие — 20/200 = 0.1, ниже по абсолютному значению, но это
  // НАСТОЯЩЕЕ совпадение на большой выборке. Без порога шумовой сосед 10
  // обгоняет настоящего 20; порог обязан убрать 10 целиком, а не просто
  // понизить его в рейтинге.
  const mine = Array.from({ length: 223 }, (_, i) => item(i + 1));
  const noisy = [item(1), item(2), ...Array.from({ length: 9 }, (_, i) => item(500 + i))];
  const genuine = [
    ...Array.from({ length: 20 }, (_, i) => item(i + 1)),
    ...Array.from({ length: 180 }, (_, i) => item(700 + i)),
  ];

  const deps: NeighborDeps = {
    collectors: async () => [10, 20],
    collectionOf: async (fanId) => (fanId === 10 ? noisy : genuine),
  };

  const withoutThreshold = await computeNeighbors(deps, {
    ownerFanId: 999,
    mine,
    seedCount: 1,
    candidateLimit: 10,
    neighborLimit: 10,
    minCollectionSize: 0,
  });
  assert.equal(withoutThreshold[0]?.fanId, 10);

  const withThreshold = await computeNeighbors(deps, {
    ownerFanId: 999,
    mine,
    seedCount: 1,
    candidateLimit: 10,
    neighborLimit: 10,
    minCollectionSize: 100,
  });
  assert.deepEqual(
    withThreshold.map((n) => n.fanId),
    [20],
  );
});
