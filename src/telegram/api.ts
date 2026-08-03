export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboard {
  inline_keyboard: InlineButton[][];
}

export interface TelegramUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
}

/** Заменяет устаревший disable_web_page_preview (Bot API 7.0+). */
export interface LinkPreviewOptions {
  is_disabled?: boolean;
  url?: string;
  prefer_small_media?: boolean;
  prefer_large_media?: boolean;
  show_above_text?: boolean;
}

/**
 * Ошибка вызова Bot API. Несёт достаточно данных, чтобы вызывающий код (ежедневный
 * джоб) отличил временный сбой от постоянного и понял, какому получателю не ушло
 * сообщение — chat_id того же вызова, которым бьёт эта ошибка.
 */
export class TelegramApiError extends Error {
  readonly method: string;
  readonly errorCode: number | undefined;
  readonly retryAfter: number | undefined;
  readonly chatId: string | number | undefined;

  constructor(
    method: string,
    description: string,
    errorCode: number | undefined,
    retryAfter: number | undefined,
    chatId: string | number | undefined,
  ) {
    super(`telegram ${method}: ${description}`);
    this.name = 'TelegramApiError';
    this.method = method;
    this.errorCode = errorCode;
    this.retryAfter = retryAfter;
    this.chatId = chatId;
  }

  /**
   * 429 (рейт-лимит, добавляет retry_after) и 5xx (Telegram временно недоступен) стоит
   * повторить позже. 400/401/403/404 повтором не лечатся — плохой токен, бот не админ
   * в канале, чат не найден и т.п. — там нужно сообщать владельцу, а не долбить снова.
   */
  get recoverable(): boolean {
    return this.errorCode === 429 || (this.errorCode !== undefined && this.errorCode >= 500);
  }
}

function extractChatId(payload: unknown): string | number | undefined {
  if (typeof payload !== 'object' || payload === null || !('chat_id' in payload)) return undefined;
  const chatId = (payload as { chat_id?: unknown }).chat_id;
  return typeof chatId === 'string' || typeof chatId === 'number' ? chatId : undefined;
}

export class Telegram {
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(token: string, fetchImpl: typeof fetch = fetch) {
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  async #call<T>(method: string, payload: unknown): Promise<T> {
    const response = await this.#fetch(`https://api.telegram.org/bot${this.#token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let body: {
      ok: boolean;
      result?: T;
      description?: string;
      error_code?: number;
      parameters?: { retry_after?: number };
    };
    try {
      body = await response.json();
    } catch {
      // Не JSON — прокси или сам Telegram отдали, например, HTML-страницу с 5xx.
      // Заворачиваем в тот же типизированный класс ошибки: без этого во время
      // двухчасового опроса джоб падает от сырого SyntaxError вместо понятного
      // recoverable-сигнала, HTTP-статус вместо error_code — больше опереться не на что.
      throw new TelegramApiError(
        method,
        `не удалось разобрать ответ (HTTP ${response.status})`,
        response.status,
        undefined,
        extractChatId(payload),
      );
    }
    if (!body.ok) {
      throw new TelegramApiError(
        method,
        body.description ?? 'неизвестная ошибка',
        body.error_code,
        body.parameters?.retry_after,
        extractChatId(payload),
      );
    }
    return body.result as T;
  }

  sendMessage(payload: {
    chat_id: string | number;
    text: string;
    parse_mode?: 'HTML';
    reply_markup?: InlineKeyboard;
    link_preview_options?: LinkPreviewOptions;
  }): Promise<{ message_id: number }> {
    return this.#call('sendMessage', payload);
  }

  sendPhoto(payload: {
    chat_id: string | number;
    photo: string;
    caption: string;
    parse_mode?: 'HTML';
    reply_markup?: InlineKeyboard;
  }): Promise<{ message_id: number }> {
    return this.#call('sendPhoto', payload);
  }

  /**
   * timeout по умолчанию — 30с длинного опроса, не 0.
   *
   * Джоб ждёт нажатий кнопок около двух часов независимо от стратегии опроса — раннер
   * GitHub Actions платит за эти два часа стены в любом случае, живым ли HTTP-соединением
   * внутри getUpdates или собственным sleep() между короткими запросами. Разница не в
   * минутах CI, а в количестве запросов и риске упереться в рейт-лимит Telegram: с
   * timeout=0 (busy-poll) без ручной паузы между вызовами за два часа набегают тысячи
   * запросов; с 30-секундным long-poll — около 240. Долгий опрос не удлиняет и не
   * укорачивает сам джоб — он просто ждёт эффективнее.
   */
  getUpdates(offset: number, timeout = 30): Promise<TelegramUpdate[]> {
    return this.#call('getUpdates', { offset, timeout, allowed_updates: ['callback_query'] });
  }

  answerCallbackQuery(payload: { callback_query_id: string; text?: string }): Promise<boolean> {
    return this.#call('answerCallbackQuery', payload);
  }

  editMessageCaption(payload: {
    chat_id: string | number;
    message_id: number;
    caption: string;
    parse_mode?: 'HTML';
    reply_markup?: InlineKeyboard;
  }): Promise<unknown> {
    return this.#call('editMessageCaption', payload);
  }

  /**
   * Для карточек без обложки (отправленных через sendMessage, без caption) —
   * editMessageCaption на таком сообщении Telegram отклоняет. Какой из двух методов
   * звать — решает вызывающий код, этот модуль просто предоставляет оба.
   */
  editMessageText(payload: {
    chat_id: string | number;
    message_id: number;
    text: string;
    parse_mode?: 'HTML';
    reply_markup?: InlineKeyboard;
  }): Promise<unknown> {
    return this.#call('editMessageText', payload);
  }
}
