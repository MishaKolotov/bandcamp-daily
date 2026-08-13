/** Идентификатор жанрового бакета — среза вкуса владельца, против профиля которого скорится кандидат. */
export type BucketId = 'crust' | 'death-metal' | 'hardcore-punk' | 'black-metal' | 'electronic';

/** Позиция из коллекции или вишлиста фаната. */
export interface FanItem {
  itemId: number;
  bandId: number;
  title: string;
  artist: string;
  url: string;
  /**
   * Субдомен Bandcamp (URL-слаг вида `lavidaesunmus`). Это НЕ то же самое, что
   * `AlbumDetails.label` — там человекочитаемое имя лейбла со страницы релиза.
   * Веса лейблов в профиле считаются по имени, а не по субдомену.
   */
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

/**
 * Релиз-претендент на пост: то же, что и страница релиза, плюс откуда он взялся.
 * Наследование от AlbumDetails не даёт полям разъехаться при правках.
 */
export interface Candidate extends AlbumDetails {
  itemId: number;
  url: string;
  alsoCollected: number;
}
