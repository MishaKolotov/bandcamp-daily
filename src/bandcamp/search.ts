/**
 * Поиск артиста на Bandcamp по имени.
 *
 * Нужен ради одного: перевести имена артистов из Spotify в теги Bandcamp.
 * Spotify с 2026 года не отдаёт жанры вовсе (поле `genres` вырезано из объекта
 * артиста вместе с `followers` и `popularity`), так что «что владелец слушает»
 * оттуда достаётся только именами. А теги нужны в словаре Bandcamp — там же,
 * откуда приходят кандидаты, и тем же, которым оперирует скоринг.
 *
 * Используется публичный автокомплит-эндпоинт: он отдаёт `tag_names` прямо в
 * ответе, так что страницу артиста скрапить не приходится — один POST на имя
 * вместо поиска плюс загрузки профиля.
 */

export interface BandMatch {
  name: string;
  subdomain: string;
  /** Теги как их пишет сам Bandcamp: 'Electronic', 'techno', 'hardcore punk'. */
  tags: string[];
  location: string | null;
}

interface AutocompleteResult {
  type?: string;
  name?: string;
  item_url_root?: string;
  tag_names?: string[];
  genre_name?: string | null;
  location?: string | null;
}

/**
 * Приводит имя к виду, в котором сравнение устойчиво к оформлению.
 *
 * Bandcamp и Spotify по-разному пишут одно и то же: регистр, диакритика
 * («Këkht Aräkh»), артикли, пунктуация («Jak3 / Trashman»). Сравнивать сырые
 * строки значит терять половину совпадений; сравнивать нестрого — ловить
 * чужих артистов с похожим именем, что хуже: чужие теги отравят профиль
 * молча.
 */
export function normalizeArtistName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^the /, "");
}

/** Достаёт субдомен из `https://name.bandcamp.com` — ключ артиста в остальном коде. */
export function subdomainOf(itemUrlRoot: string | undefined): string | null {
  if (!itemUrlRoot) return null;
  const match = /^https?:\/\/([^.]+)\.bandcamp\.com/i.exec(itemUrlRoot);
  return match?.[1] ?? null;
}

/**
 * Выбирает из результатов поиска того, чьё имя совпадает с запрошенным после
 * нормализации.
 *
 * Именно совпадение, а не «первый результат»: автокомплит охотно отдаёт
 * что-нибудь на любой запрос, и взяв первое попавшееся, мы приписали бы
 * владельцу теги случайной группы. Ложное совпадение здесь дороже пропуска —
 * пропущенный артист просто не добавит весов, а чужой добавит неверные.
 */
export function pickExactMatch(query: string, results: AutocompleteResult[]): BandMatch | null {
  const wanted = normalizeArtistName(query);
  for (const result of results) {
    if (result.type !== "b" || !result.name) continue;
    if (normalizeArtistName(result.name) !== wanted) continue;
    const subdomain = subdomainOf(result.item_url_root);
    if (!subdomain) continue;
    // genre_name дублирует один из tag_names далеко не всегда — Bandcamp
    // держит «жанр» отдельным полем витрины, и у электронщиков там регулярно
    // лежит 'Electronic', которого нет в тегах.
    const tags = [...(result.tag_names ?? []), ...(result.genre_name ? [result.genre_name] : [])];
    return {
      name: result.name,
      subdomain,
      tags: [...new Set(tags.map((t) => t.trim()).filter(Boolean))],
      location: result.location ?? null,
    };
  }
  return null;
}

/**
 * Ищет артиста на Bandcamp. `null` — не найден или найден кто-то другой.
 *
 * `fetchImpl` параметром, чтобы тесты не ходили в сеть, — как и в остальном
 * коде репозитория.
 */
export async function searchBand(
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BandMatch | null> {
  const res = await fetchImpl("https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0" },
    body: JSON.stringify({ search_text: name, search_filter: "b", full_page: false, fan_id: null }),
  });
  if (!res.ok) throw new Error(`поиск «${name}»: HTTP ${res.status}`);
  const body = (await res.json()) as { auto?: { results?: AutocompleteResult[] } };
  return pickExactMatch(name, body.auto?.results ?? []);
}
