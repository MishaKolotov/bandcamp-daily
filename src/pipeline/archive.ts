import type { AlbumDetails, Candidate } from '../bandcamp/types.ts';
import type { Neighbor } from './neighbors.ts';

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
 * Архивное открытие: то, что купили близкие по вкусу люди, а владелец пропустил.
 * Голоса соседей взвешены их близостью, поэтому случайный человек с одним
 * общим релизом почти ни на что не влияет.
 */
export async function archiveCandidates(
  deps: ArchiveDeps,
  options: ArchiveOptions,
): Promise<Candidate[]> {
  // Ключ — URL (см. комментарий у ArchiveOptions.exclude): один и тот же
  // релиз у двух соседей должен схлопнуться в одну запись и суммировать
  // веса, даже если по какой-то случайности их itemId разошлись.
  const votes = new Map<string, { weight: number; itemId: number; title: string; artist: string }>();
  for (const neighbor of options.neighbors) {
    for (const item of neighbor.items) {
      if (options.exclude.has(item.url)) continue;
      const current = votes.get(item.url);
      if (current) current.weight += neighbor.weight;
      else votes.set(item.url, { weight: neighbor.weight, itemId: item.itemId, title: item.title, artist: item.artist });
    }
  }

  const ranked = [...votes.entries()]
    .sort((a, b) => b[1].weight - a[1].weight)
    .slice(0, options.limit);

  const candidates: Candidate[] = [];
  for (const [url, vote] of ranked) {
    const details = await deps.album(url);
    if (!details) continue;
    candidates.push({
      itemId: vote.itemId,
      url,
      title: details.title || vote.title,
      artist: details.artist || vote.artist,
      label: details.label,
      tags: details.tags,
      releasedAt: details.releasedAt,
      artUrl: details.artUrl,
      alsoCollected: 0,
      origin: 'archive',
      neighborWeight: Number(vote.weight.toFixed(4)),
    });
  }
  return candidates;
}
