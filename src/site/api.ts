/**
 * Клиент эндпоинтов подборщика на gigamike666.com.
 *
 * Весь телеграм-слой (карточка, кнопки, диалог описания, посты) живёт на
 * сайте: у него вебхук, открытый круглосуточно, а этот репозиторий — джоб,
 * который живёт минуты. Отсюда наружу уходят ровно два вызова: прочитать,
 * что владельцу уже показывали, и отдать сегодняшнего победителя.
 *
 * Типы `PickerContext`/`PickRequest` здесь продублированы, а НЕ импортированы
 * из репозитория сайта: репозитории деплоятся независимо, общего билда у них
 * нет, и форма запроса — это контракт HTTP-эндпоинта, а не общий тип. Сайт
 * держит свою копию (`src/lib/picker/types.ts`) и валидирует тело зодом на
 * границе — расхождение обязано всплыть там, ответом 400 с полем, а не тихо
 * пройти дальше.
 */

/** Кандидат в том виде, в каком его принимает `/api/picker/pick`. */
export interface SiteCandidate {
  url: string;
  title: string;
  artist: string;
  label: string | null;
  tags: string[];
  releasedAt: string | null;
  artUrl: string | null;
  origin: 'fresh' | 'archive';
}

/**
 * Запасной вариант для кнопки «Другой» — кандидат вместе со СВОИМ жанром.
 *
 * Запас сквозной по всем бакетам, поэтому следующий вариант почти наверняка
 * другого жанра, чем победитель. Сайт при подмене перерисовывает подпись
 * карточки по `bucketTitle` варианта и берёт из него же теги под штраф —
 * без этого карточка писала бы жанр победителя, а показывала чужой.
 */
export interface SiteAlternative {
  bucket: string;
  bucketTitle: string;
  candidate: SiteCandidate;
  penaltyTags: string[];
}

/** Тело `POST /api/picker/pick` — победитель захода плюс запас на кнопку «Другой». */
export interface PickRequest {
  bucket: string;
  /**
   * Человекочитаемое имя жанра для подписи карточки. Присылается отсюда, а не
   * мапится на сайте: список бакетов и их названия живут в
   * `../profile/buckets.ts` и там же меняются.
   */
  bucketTitle: string;
  candidate: SiteCandidate;
  /**
   * Что штрафовать по кнопке «Не моё» — совпавшие теги МИНУС опорные теги
   * бакета. Вычитание делается здесь, потому что опорные теги знает только
   * этот репозиторий; без него отказ штрафовал бы тег, который по построению
   * несёт каждый релиз бакета, и бакет за месяц отбраковал бы сам себя.
   */
  penaltyTags: string[];
  total: number;
  alternatives: SiteAlternative[];
}

/** Ответ `GET /api/picker/context` — всё, что нужно знать о прошлом, чтобы не повторяться. */
export interface PickerContext {
  seen: string[];
  feedbackTags: Record<string, number>;
  lastBucket: string | null;
}

export class SiteApi {
  readonly #baseUrl: string;
  readonly #secret: string;
  readonly #fetch: typeof fetch;

  constructor(baseUrl: string, secret: string, fetchImpl: typeof fetch = fetch) {
    // Хвостовой слеш в SITE_URL — обычная опечатка в переменной окружения, а
    // склеенный из него `//api/picker/context` Vercel отдал бы 404, и разбираться
    // владелец пошёл бы в код, а не в настройку.
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#secret = secret;
    this.#fetch = fetchImpl;
  }

  async readContext(): Promise<PickerContext> {
    return this.#request<PickerContext>('GET', '/api/picker/context');
  }

  async sendPick(pick: PickRequest): Promise<{ messageId: number }> {
    return this.#request<{ messageId: number }>('POST', '/api/picker/pick', pick);
  }

  /**
   * Любой не-2xx — исключение, роняющее прогон.
   *
   * Тихо вернуть пустой контекст на 401 или 500 нельзя: пустой `seen` означает
   * «владельцу ещё ничего не показывали», и заход честно предложит то, что тот
   * уже видел вчера или прямо скипнул кнопкой. Сбой связи с сайтом обязан
   * выглядеть как красный джоб, а не как подборщик, у которого внезапно отшибло
   * память.
   *
   * Тело ответа попадает в сообщение целиком: у сайта это `{"error":"..."}` или
   * зодовский разбор с именами полей — ровно то, по чему видно, разошёлся ли
   * контракт, и ровно то, чего не видно из одного лишь статуса.
   */
  async #request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = `${this.#baseUrl}${path}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.#secret}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await this.#fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`${method} ${url} — ${response.status}: ${text.slice(0, 500)}`);
    }
    return (await response.json()) as T;
  }
}
