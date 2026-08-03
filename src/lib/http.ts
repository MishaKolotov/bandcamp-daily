import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const USER_AGENT =
  'bandcamp-daily/1.0 (personal listening recommender; contact: github.com/MishaKolotov/bandcamp-daily)';

const RETRYABLE = Symbol('retryable');

function markRetryable(error: Error): void {
  (error as Error & { [RETRYABLE]?: true })[RETRYABLE] = true;
}

function isRetryable(error: unknown): boolean {
  return error instanceof Error && (error as Error & { [RETRYABLE]?: true })[RETRYABLE] === true;
}

export interface HttpOptions {
  fetchImpl?: typeof fetch;
  cacheDir?: string;
  minDelayMs?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class Http {
  readonly #fetch: typeof fetch;
  readonly #cacheDir: string | null;
  readonly #minDelayMs: number;
  readonly #retries: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  #chain: Promise<unknown> = Promise.resolve();
  #lastAt = Number.NEGATIVE_INFINITY;

  constructor(options: HttpOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#cacheDir = options.cacheDir ?? null;
    this.#minDelayMs = options.minDelayMs ?? 900;
    this.#retries = options.retries ?? 2;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#now = options.now ?? Date.now;
  }

  /** Все запросы выстраиваются в одну очередь: к Bandcamp ходим строго по одному. */
  #enqueue<T>(job: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(job, job);
    this.#chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #throttle(): Promise<void> {
    const waited = this.#now() - this.#lastAt;
    if (waited < this.#minDelayMs) await this.#sleep(this.#minDelayMs - waited);
    this.#lastAt = this.#now();
  }

  #cachePath(url: string): string | null {
    if (!this.#cacheDir) return null;
    const hash = createHash('sha1').update(url).digest('hex');
    return join(this.#cacheDir, `${hash}.txt`);
  }

  async #send(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#retries; attempt += 1) {
      await this.#throttle();
      try {
        const response = await this.#fetch(url, {
          ...init,
          headers: { 'User-Agent': USER_AGENT, ...(init.headers ?? {}) },
        });
        if (!response.ok) {
          const error = new Error(`bandcamp ответил ${response.status} на ${url}`);
          // Только 429/5xx имеет смысл повторять — это перегрузка/сбой на их стороне.
          // Остальные не-ok статусы (404 и т.п.) не исправит повтор — фейлимся сразу.
          if (response.status === 429 || response.status >= 500) markRetryable(error);
          throw error;
        }
        return await response.text();
      } catch (error) {
        lastError = error;
        if (!isRetryable(error)) throw error;
        // Бэкофф здесь всегда >= minDelayMs, так что следующий #throttle() почти не спит —
        // паузы не складываются. Если формулу когда-нибудь уменьшат ниже minDelayMs, это условие сломается.
        if (attempt < this.#retries) await this.#sleep(this.#minDelayMs * (attempt + 2));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async getText(url: string, { cache = false }: { cache?: boolean } = {}): Promise<string> {
    const path = cache ? this.#cachePath(url) : null;
    if (path) {
      try {
        return await readFile(path, 'utf8');
      } catch {
        // промах кэша — идём в сеть
      }
    }
    const body = await this.#enqueue(() => this.#send(url, { method: 'GET' }));
    if (path && this.#cacheDir) {
      await mkdir(this.#cacheDir, { recursive: true });
      await writeFile(path, body, 'utf8');
    }
    return body;
  }

  async postJson<T>(url: string, body: unknown): Promise<T> {
    const text = await this.#enqueue(() =>
      this.#send(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    return JSON.parse(text) as T;
  }
}
