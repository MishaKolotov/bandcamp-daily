import type { AlbumDetails, Candidate } from '../bandcamp/types.ts';
import type { DiscoverItem, DiscoverOptions } from '../bandcamp/discover.ts';
import type { BandRelease } from '../bandcamp/band.ts';

export interface FreshDeps {
  discover: (options: DiscoverOptions) => Promise<DiscoverItem[]>;
  bandReleases: (subdomain: string) => Promise<BandRelease[]>;
  album: (url: string) => Promise<AlbumDetails | null>;
}

export interface FreshOptions {
  /** Теги бакета, по которым опрашиваются хабы. */
  tags: string[];
  /**
   * Субдомены групп и лейблов из подписок.
   *
   * Подписки владельца (166 штук) не жанровые — один и тот же список
   * логично передавать в каждый бакет. Но `bandReleases` тут не кешируется
   * (см. `fetchBandReleases`: сетевой запрос за /music каждый раз честно
   * бьёт по сети, в отличие от `album`, который кеширует уже разобранные
   * страницы навсегда) — так что если вызывающий код (дневной прогон, ещё
   * не написан) прогонит через `freshCandidates` все бакеты с одним и
   * тем же полным списком подписок, каждая из 166 страниц /music будет
   * скачана по разу на бакет за прогон вместо одного раза суммарно. Эта
   * функция такого не решает и не должна: у неё нет памяти между
   * вызовами. Развести общий список подписок по бакетам, свести fetch
   * дискографий в один проход и раздать результат всем бакетам — забота
   * вызывающего кода.
   */
  subdomains: string[];
  now: Date;
  maxAgeDays: number;
  /**
   * Сколько дней предзаказ может быть датирован вперёд и всё ещё считаться
   * свежим. Без этого потолка лейбл, выставивший предзаказ на полгода
   * вперёд, всплывал бы как «новинка» в каждом прогоне, пока релиз
   * действительно не выйдет, — то же самое письмо владельцу месяцами.
   * Рекомендуемое значение — 30: у Bandcamp обычное окно предзаказа
   * 2–8 недель, и месяц с запасом покрывает его, не пропуская вперёд
   * анонсы, до которых ещё далеко.
   */
  maxFutureDays: number;
}

function ageInDays(releasedAt: string, now: Date): number {
  return (now.getTime() - new Date(releasedAt).getTime()) / 86_400_000;
}

/**
 * cyrb53 — компактный детерминированный строковый хеш без зависимостей,
 * даёт 53-битное число (весь безопасный диапазон `Number` в JS).
 *
 * Нужен для релизов, найденных через дискографию группы/лейбла: у таких
 * нет числового `item_id` от Bandcamp (страница /music его не отдаёт), а
 * itemId в `Candidate` используется потом и как ключ дедупликации «уже
 * показано», и как содержимое callback_data телеграм-кнопок, по которому
 * нажатие сопоставляется с конкретной карточкой. Присвоить всем такой
 * itemId: 0 — значит слить их все в одну запись при дедупе и сделать
 * нажатие кнопки на любой из них неотличимым от нажатия на любую другую.
 * Хеш URL детерминирован (один и тот же релиз в разных прогонах получает
 * один и тот же id) и с исчезающе малой вероятностью коллизий на объёмах,
 * которые видит один канал.
 */
function hashUrl(url: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < url.length; i++) {
    const ch = url.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Свежак = новинки тег-хабов плюс новые релизы тех, на кого владелец подписан.
 * Второй источник важен: у любимого лейбла релиз попадает сюда в день выхода,
 * даже если тегов Bandcamp ещё не проставил.
 */
export async function freshCandidates(
  deps: FreshDeps,
  options: FreshOptions,
): Promise<Candidate[]> {
  const seen = new Map<string, { title: string; artist: string; itemId: number }>();

  // Последовательные await, а не Promise.all: все эти вызовы в итоге идут
  // через общий Http-клиент, а он и так сериализует и выдерживает паузу
  // между запросами сам (см. #enqueue/#throttle в lib/http.ts) —
  // распараллеливание тут ничего не ускорит, только унесёт троттлинг из
  // http.ts в случайный порядок готовности промисов.
  for (const tag of options.tags) {
    for (const item of await deps.discover({ tag, slice: 'new', size: 60 })) {
      if (item.url) seen.set(item.url, { title: item.title, artist: item.artist, itemId: item.itemId });
    }
  }
  for (const subdomain of options.subdomains) {
    for (const release of await deps.bandReleases(subdomain)) {
      if (!seen.has(release.url)) {
        seen.set(release.url, { title: release.title, artist: '', itemId: hashUrl(release.url) });
      }
    }
  }

  const candidates: Candidate[] = [];
  let dropped = 0;
  for (const [url, base] of seen) {
    const details = await deps.album(url);
    if (!details?.releasedAt) {
      dropped += 1;
      continue;
    }
    const age = ageInDays(details.releasedAt, options.now);
    if (age > options.maxAgeDays || age < -options.maxFutureDays) continue;
    candidates.push({
      itemId: base.itemId,
      url,
      title: details.title || base.title,
      artist: details.artist || base.artist,
      label: details.label,
      tags: details.tags,
      releasedAt: details.releasedAt,
      artUrl: details.artUrl,
      alsoCollected: 0,
      origin: 'fresh',
    });
  }
  // discover.ts и band.ts уже сигналят «результат может быть неполным» —
  // усечённый хаб, нерабочая страница дискографии. Тут тот же класс потерь:
  // страница релиза не открылась или не отдала дату. Одна строка на весь
  // прогон бакета, не по кандидату — падения отдельных страниц уже видны
  // в логе из fetchAlbum/http.ts, здесь важна только сводная цифра.
  if (dropped > 0) {
    console.warn(`fresh: ${dropped} из ${seen.size} кандидатов выброшены — нет доступной даты релиза`);
  }
  return candidates;
}
