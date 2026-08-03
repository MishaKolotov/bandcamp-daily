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
      // Знаменатель — overlap как доля МЕНЬШЕЙ из двух коллекций. Так
      // родственная душа с маленькой, почти целиком совпадающей коллекцией
      // (60 релизов, 50 из них общие — вес 50/60) отличима от всеядного
      // коллекционера с теми же 50 общими релизами, растворёнными в 5000
      // чужих (вес 50/5000) — это и есть смысл меры близости, его нельзя
      // терять ради защиты от усечения.
      // Усечение чужой коллекции лимитом страниц (см. maxPages в
      // fetchFanItems) эту меру не портит: страница обрывается только на
      // коллекциях порядка тысячи с лишним релизов (см. MAX_PAGES/PAGE_SIZE
      // в bandcamp/fan.ts) — на порядок больше 223 релизов владельца.
      // Значит усечение возможно ровно тогда, когда theirs.length и так
      // на порядок больше mineIds.size, и Math.min уже вернул бы
      // mineIds.size независимо от того, где именно чужую коллекцию
      // оборвали. Инфляция веса потребовала бы усечённой коллекции МЕНЬШЕ
      // 223 позиций, а лимит страниц такого дать не может.
      weight: Number((overlap / Math.min(theirs.length, mineIds.size)).toFixed(4)),
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
