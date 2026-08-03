import type { Http } from '../lib/http.ts';

const ENDPOINT = 'https://bandcamp.com/api/tralbumcollectors/2/thumbs';

interface CollectorsResponse {
  results?: { fan_id: number }[];
}

/**
 * fan_id тех, у кого этот релиз в коллекции. Вход в граф соседей по вкусу.
 *
 * Несуществующий/мёртвый tralbum_id не даёт HTTP-ошибку — проверено вживую:
 * Bandcamp отвечает 200 с `{"results":[],"more_available":false}`, и это
 * неотличимо от «у релиза правда нет коллекционеров». Значит любое
 * исключение здесь (не-2xx после ретраев, сеть, битый JSON тела ответа) —
 * это не пустой, а сбойный результат: Bandcamp упал или сменил формат
 * ответа, и это должно быть видно в логе, а не тихо превращаться в тот же
 * пустой список, что и легитимное отсутствие покупателей.
 */
export async function fetchCollectors(
  http: Http,
  albumId: number,
  count = 40,
): Promise<number[]> {
  try {
    const body = await http.postJson<CollectorsResponse>(ENDPOINT, {
      tralbum_type: 'a',
      tralbum_id: albumId,
      count,
    });
    return (body.results ?? []).map((fan) => fan.fan_id);
  } catch (error) {
    console.error(`коллекционеры релиза ${albumId}: запрос не удался —`, error);
    return [];
  }
}
