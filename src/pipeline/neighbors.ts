import type { FanItem } from '../bandcamp/types.ts';

export interface NeighborItem {
  itemId: number;
  url: string;
  title: string;
  artist: string;
}

export interface Neighbor {
  fanId: number;
  /** Доля пересечения с коллекцией владельца, 0..1. */
  weight: number;
  items: NeighborItem[];
}

export interface NeighborDeps {
  collectors: (albumId: number) => Promise<number[]>;
  /**
   * Коллекция чужого фаната. Та же fetchFanItems, что читает коллекцию
   * владельца — и с тем же поведением при сбое: бросает исключение вместо
   * того, чтобы молча вернуть []. Среди десятков произвольных чужих
   * аккаунтов почти наверняка есть удалённый, приватный или переименованный
   * — вызывающий код (computeNeighbors) обязан пережить это для одного
   * fanId, не теряя уже посчитанных соседей.
   */
  collectionOf: (fanId: number) => Promise<FanItem[]>;
}

export interface NeighborOptions {
  ownerFanId: number;
  mine: FanItem[];
  /** Сколько своих релизов взять как затравку графа. */
  seedCount: number;
  /** Сколько самых часто встречающихся фанатов проверять на пересечение. */
  candidateLimit: number;
  neighborLimit: number;
}

/**
 * Затравка графа — разреженная выборка по всей коллекции, а не первые N.
 *
 * `mine` приходит от fetchFanItems в порядке, в котором Bandcamp отдаёт
 * страницы: первая страница — самые свежие позиции (см. START_TOKEN в
 * bandcamp/fan.ts). `mine.slice(0, seedCount)` взял бы только то, что
 * владелец добавил последним — если это была неделя запоем одного лейбла
 * или сайд-проекта, весь граф соседей строился бы по этому узкому срезу
 * вместо всего вкуса за годы. Вместо этого берём seedCount точек, равномерно
 * разнесённых по всей длине коллекции: детерминированно (никакого
 * Math.random — недельный прогон обязан быть воспроизводим), но
 * представляющую всю историю коллекции, а не только хвост.
 */
function pickSeeds(mine: FanItem[], seedCount: number): FanItem[] {
  if (mine.length <= seedCount) return mine;
  const seeds: FanItem[] = [];
  for (let i = 0; i < seedCount; i += 1) {
    seeds.push(mine[Math.floor((i * mine.length) / seedCount)]!);
  }
  return seeds;
}

export async function computeNeighbors(
  deps: NeighborDeps,
  options: NeighborOptions,
): Promise<Neighbor[]> {
  const mineIds = new Set(options.mine.map((item) => item.itemId));
  const seeds = pickSeeds(options.mine, options.seedCount);

  // Сколько раз каждый фанат встретился среди покупателей моих релизов.
  const votes = new Map<number, number>();
  for (const seed of seeds) {
    for (const fanId of await deps.collectors(seed.itemId)) {
      if (fanId === options.ownerFanId) continue;
      votes.set(fanId, (votes.get(fanId) ?? 0) + 1);
    }
  }

  const shortlist = [...votes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, options.candidateLimit)
    .map(([fanId]) => fanId);

  const neighbors: Neighbor[] = [];
  for (const fanId of shortlist) {
    let theirs: FanItem[];
    try {
      theirs = await deps.collectionOf(fanId);
    } catch (error) {
      // deps.collectionOf (fetchFanItems) бросает на сбое транспорта, в
      // отличие от fetchCollectors, который сам глотает ошибку и отдаёт [].
      // Одна мёртвая/приватная/переименованная страница из полусотни не
      // должна ронять весь недельный прогон и уничтожать уже посчитанных
      // соседей — пропускаем этого фаната и логируем причину.
      console.warn(`сосед ${fanId}: коллекция недоступна —`, error);
      continue;
    }
    if (theirs.length === 0) continue;
    const overlap = theirs.filter((item) => mineIds.has(item.itemId)).length;
    if (overlap === 0) continue;
    neighbors.push({
      fanId,
      // Знаменатель — размер СВОЕЙ коллекции (mineIds.size), а не
      // Math.min(theirs.length, mineIds.size). theirs.length — не всегда
      // настоящий размер чужой коллекции: fetchFanItems постранично читает
      // её под лимитом maxPages и при обрыве честно предупреждает в лог, но
      // не сигналит об этом сюда через возвращаемое значение. Знаменатель,
      // построенный на theirs.length, усыхает вместе с усечением — тот же
      // overlap тогда даёт вес выше, чем дала бы полная коллекция, и ничего
      // в данных этого не показывает. mineIds.size от чужой коллекции не
      // зависит вовсе: усечение способно только недосчитать overlap
      // (числитель), но не исказить знаменатель. Смысл при этом совпадает
      // с документацией поля weight выше: доля пересечения с КОЛЛЕКЦИЕЙ
      // ВЛАДЕЛЬЦА.
      weight: Number((overlap / mineIds.size).toFixed(4)),
      items: theirs.map((item) => ({
        itemId: item.itemId,
        url: item.url,
        title: item.title,
        artist: item.artist,
      })),
    });
  }

  return neighbors.sort((a, b) => b.weight - a.weight).slice(0, options.neighborLimit);
}
