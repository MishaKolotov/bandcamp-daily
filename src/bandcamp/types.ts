/** Идентификатор жанрового бакета = целевой телеграм-канал. */
export type BucketId = 'crust' | 'death-metal' | 'hardcore-punk';

/** Позиция из коллекции или вишлиста фаната. */
export interface FanItem {
  itemId: number;
  bandId: number;
  title: string;
  artist: string;
  url: string;
  /** Субдомен Bandcamp — он же лейбл, если релиз издан не самим артистом. */
  subdomain: string;
  alsoCollected: number;
  /** ISO-дата добавления в коллекцию/вишлист. */
  addedAt: string;
  source: 'collection' | 'wishlist';
}

/** Данные, вытащенные из ld+json страницы релиза. */
export interface AlbumDetails {
  title: string;
  artist: string;
  label: string | null;
  tags: string[];
  /** ISO-дата публикации, null если Bandcamp её не отдал. */
  releasedAt: string | null;
  artUrl: string | null;
}

export interface BandRef {
  bandId: number;
  name: string;
  subdomain: string;
  location: string | null;
}

/** Релиз-претендент на пост, уже с тегами и датой. */
export interface Candidate {
  itemId: number;
  url: string;
  title: string;
  artist: string;
  label: string | null;
  tags: string[];
  releasedAt: string | null;
  artUrl: string | null;
  alsoCollected: number;
  origin: 'fresh' | 'archive';
  /** Для архивных — суммарный вес проголосовавших соседей. */
  neighborWeight?: number;
}
