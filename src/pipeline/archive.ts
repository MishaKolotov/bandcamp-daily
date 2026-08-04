import type { AlbumDetails, Candidate } from '../bandcamp/types.ts';
import type { Neighbor } from './neighbors.ts';
import { hashUrl } from '../lib/hash.ts';

export interface ArchiveDeps {
  album: (url: string) => Promise<AlbumDetails | null>;
}

export interface ArchiveOptions {
  neighbors: Neighbor[];
  /**
   * URL релизов, которые уже есть у владельца или уже показывались.
   *
   * Ключ — URL, а не itemId. По решению, зафиксированному в плане
   * ("Состояние «уже показывали» ключуется по URL, а не по itemId"):
   * itemId ненадёжен как ключ между источниками — у релизов, найденных
   * через дискографию группы/лейбла (fresh.ts), настоящего item_id от
   * Bandcamp нет, вместо него подставлен детерминированный хеш URL; тот же
   * релиз, увиденный позже через Discover или в коллекции соседа, придёт с
   * настоящим numeric item_id — по itemId это два разных релиза, по URL
   * один и тот же. itemId остаётся только удобной ручкой для callback_data
   * в Telegram, но не ключом дедупликации.
   */
  exclude: Set<string>;
  /** Сколько верхних претендентов проверять по тегам — это сетевые запросы. */
  limit: number;
}

/**
 * Доля хвоста, идущего в счёт голосования сверх самого близкого голоса.
 *
 * Голоса за релиз — это не сумма весов проголосовавших соседей. Сумма даёт
 * ровно обратный эффект тому, ради чего вообще считается weight: двадцать
 * едва пересекающихся соседей по 0.05 в сумме дают 1.0 и обгоняют одного
 * близнеца по вкусу с весом 0.9 — то есть по «попал ко всем понемногу»,
 * а не по «понравился тому, кто реально похож». Это тот же bias
 * «популярно у всех», который weight в neighbors.ts был придуман гасить, он
 * просто пролезает обратно на следующем шаге, если голоса складывать сырым
 * образом.
 *
 * Вместо суммы — доминирующий голос плюс демпфированный хвост: вес самого
 * близкого проголосовавшего соседа целиком, плюс TAIL_WEIGHT от суммы
 * остальных. Один очень близкий сосед перевешивает толпу далёких. Но если
 * несколько по-настоящему близких соседей сходятся на одном релизе, это по
 * прежнему видно — их веса не игнорируются, просто "вес после первого"
 * учитывается не один к одному, а частично.
 */
const TAIL_WEIGHT = 0.25;

function voteScore(weights: number[]): number {
  const sorted = [...weights].sort((a, b) => b - a);
  const [dominant, ...rest] = sorted;
  return (dominant ?? 0) + TAIL_WEIGHT * rest.reduce((sum, w) => sum + w, 0);
}

/**
 * Архивное открытие: то, что купили близкие по вкусу люди, а владелец пропустил.
 * Голоса соседей взвешены их близостью, поэтому случайный человек с одним
 * общим релизом почти ни на что не влияет.
 */
export async function archiveCandidates(
  deps: ArchiveDeps,
  options: ArchiveOptions,
): Promise<Candidate[]> {
  // Ключ — URL (см. комментарий у ArchiveOptions.exclude): один и тот же
  // релиз у двух соседей должен схлопнуться в одну запись. Раньше здесь же
  // копился первый попавшийся itemId/title/artist соседа как фолбэк на
  // случай, если deps.album(url) не отдаст title/artist — но с тех пор, как
  // Neighbor.items стал Neighbor.itemUrls (см. комментарий там же:
  // data/neighbors.json не хранит ничего, кроме URL, ради размера файла),
  // такого фолбэка больше нет. Веса пока не сворачиваем — копим списком,
  // voteScore разбирается с ним ниже.
  const votes = new Map<string, number[]>();
  for (const neighbor of options.neighbors) {
    for (const url of neighbor.itemUrls) {
      if (options.exclude.has(url)) continue;
      const weights = votes.get(url);
      if (weights) weights.push(neighbor.weight);
      else votes.set(url, [neighbor.weight]);
    }
  }

  const ranked = [...votes.entries()]
    .sort((a, b) => voteScore(b[1]) - voteScore(a[1]))
    .slice(0, options.limit);

  // Контракт: без бэкафилла. Если у релиза из среза не открылась страница,
  // итог короче на одну позицию — кандидат, стоявший в очереди голосов
  // сразу за срезом (за options.limit), его не подменяет. Подмена значила
  // бы повторный проход по already-ranked списку и ещё один сетевой запрос
  // сверх заявленного лимита; проще и предсказуемее просто отдать на одну
  // карточку меньше.
  const candidates: Candidate[] = [];
  for (const [url, weights] of ranked) {
    const details = await deps.album(url);
    if (!details) continue;
    candidates.push({
      // itemId соседского релиза не хранится (см. Neighbor.itemUrls) — он и
      // раньше был лишь удобной ручкой для callback_data, а не ключом
      // дедупликации (тот идёт по url). Детерминированный хеш url даёт ту
      // же стабильность между прогонами, что и настоящий item_id, тем же
      // способом, каким уже помечены релизы без item_id в fresh.ts (см.
      // `hashUrl` в `src/lib/hash.ts`).
      itemId: hashUrl(url),
      url,
      title: details.title,
      artist: details.artist,
      label: details.label,
      tags: details.tags,
      releasedAt: details.releasedAt,
      artUrl: details.artUrl,
      alsoCollected: 0,
      origin: 'archive',
      neighborWeight: Number(voteScore(weights).toFixed(4)),
    });
  }
  return candidates;
}
