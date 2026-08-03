# Bandcamp Daily Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ежедневно подбирать по два релиза (свежий + архивный) в трёх жанрах на основе вкуса Bandcamp-фаната `gigamike666`, присылать их владельцу на апрув в Telegram и по кнопке публиковать в три канала.

**Architecture:** Скрипты на Node, запускаемые из GitHub Actions по расписанию. Всё состояние — JSON-файлы в репозитории, коммитятся в конце запуска. Слой `src/bandcamp` умеет только ходить в Bandcamp, `src/profile` — только считать веса и скор (чистые функции без сети), `src/pipeline` — собирать кандидатов, `src/telegram` — общаться с ботом. Сеть в тестах не дёргается: HTTP-клиент принимает `fetchImpl` инъекцией, парсеры тестируются на сохранённых фикстурах.

**Tech Stack:** Node 20, TypeScript через `tsx` (без шага сборки), встроенный `node:test`, `fetch` из стандартной библиотеки. Внешних рантайм-зависимостей нет.

---

## Проверенные факты о Bandcamp API

Всё ниже проверено живыми запросами 2026-08-03 при написании плана. Не переизобретать и не «улучшать» — работает именно так.

| Что нужно | Как получить |
|---|---|
| Коллекция фаната | `POST https://bandcamp.com/api/fancollection/1/collection_items`, тело `{"fan_id":7566215,"older_than_token":"9999999999::a::","count":100}`. Ответ: `{items:[...], more_available:bool, last_token:"..."}`. **Курсор следующей страницы — поле `token` последнего элемента, а не `last_token` из ответа.** На `collection_items` при `count:100` `last_token` отстаёт и двигает выборку всего на ~20 позиций, из-за чего страницы перекрываются (223 релиза превращаются в 783 строки). На `wishlist_items` и `following_bands` `last_token` совпадает с токеном последнего элемента, но брать токен элемента правильно везде. |
| Вишлист | Тот же вызов, эндпоинт `wishlist_items`. |
| Подписки на группы/лейблы | Тот же вызов, эндпоинт `following_bands`. Массив лежит в ключе **`followeers`** (опечатка Bandcamp), элементы: `{band_id, name, location, url_hints:{subdomain}}`. |
| Кандидаты по тегу | `POST https://bandcamp.com/api/discover/1/discover_web`, тело `{"category_id":0,"tag_norm_names":["crust"],"geoname_id":0,"slice":"new","time_facet_id":null,"size":60,"cursor":"*","include_result_types":["a"]}`. Ответ: `{results:[{item_id,title,item_url,band_name,band_location,...}], cursor}`. `slice` — `new` \| `top` \| `rand`. В `item_url` приклеен `?from=discover_page` — отрезать. |
| Теги, дата, лейбл, обложка релиза | GET страницы альбома, внутри `<script type="application/ld+json">`. Поля: `keywords` (массив тегов), `datePublished` (`"19 Mar 2021 00:00:00 GMT"`), `publisher.name` (лейбл), `byArtist.name`, `name`, `image` (URL обложки). Тегов в API коллекции и discover нет — только отсюда. |
| Кто купил релиз | `POST https://bandcamp.com/api/tralbumcollectors/2/thumbs`, тело `{"tralbum_type":"a","tralbum_id":2720727045,"count":40}`. Ответ: `{results:[{fan_id,username,url}], more_available}`. |
| Дискография группы | GET `https://<subdomain>.bandcamp.com/music`, атрибут `data-client-items` у `<ol id="music-grid">` — JSON-массив `{id,title,artist,page_url,type}`, новые сверху. У групп с одним релизом `/music` редиректит на страницу альбома и грида нет — это нормальный случай, обработать. |

Владелец: `fan_id = 7566215`, username `gigamike666`. Живые цифры, перепроверенные при выполнении задачи 6: **223 релиза в коллекции, 497 в вишлисте, 166 подписок** (число подписок в первой редакции плана — 45 — было взято с первой страницы профиля и оказалось неверным). Это меняет оценку стоимости: разовая сборка профиля читает ~720 страниц релизов, ежедневный обход подписок — 166 страниц `/music`.

---

## File Structure

| Файл | Ответственность |
|---|---|
| `src/lib/http.ts` | Единственная точка выхода в сеть: очередь запросов с паузой, дисковый кэш GET-страниц, User-Agent, ретраи. |
| `src/lib/state.ts` | Чтение/запись JSON-файлов состояния. |
| `src/bandcamp/types.ts` | Общие типы предметной области. |
| `src/bandcamp/album.ts` | Парсинг ld+json страницы релиза. |
| `src/bandcamp/fan.ts` | Коллекция, вишлист, подписки фаната. |
| `src/bandcamp/discover.ts` | Тег-хабы Bandcamp. |
| `src/bandcamp/collectors.ts` | Кто купил релиз. |
| `src/bandcamp/band.ts` | Дискография группы со страницы `/music`. |
| `src/profile/buckets.ts` | Определение трёх бакетов и их seed-тегов. |
| `src/profile/build.ts` | Построение `profile.json` из коллекции. |
| `src/profile/score.ts` | Чистая функция скоринга кандидата. |
| `src/pipeline/fresh.ts` | Кандидаты-новинки. |
| `src/pipeline/neighbors.ts` | Расчёт соседей по вкусу. |
| `src/pipeline/archive.ts` | Кандидаты из архива по соседям. |
| `src/pipeline/daily.ts` | Оркестрация ежедневного запуска. |
| `src/telegram/api.ts` | Голые вызовы Bot API. |
| `src/telegram/card.ts` | Сборка карточки и клавиатуры. |
| `src/telegram/approve.ts` | Обработка нажатий кнопок. |
| `bin/build-profile.ts`, `bin/neighbors.ts`, `bin/daily.ts` | Точки входа для CI. |
| `.github/workflows/daily.yml`, `neighbors-weekly.yml` | Расписание. |
| `data/*.json` | Состояние (создаётся запусками). |
| `test/fixtures/*` | Сохранённые ответы Bandcamp. |

---

## Task 1: Скелет проекта

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `src/lib/smoke.test.ts`

- [ ] **Step 1: Создать `package.json`**

```json
{
  "name": "bandcamp-daily",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20.19" },
  "scripts": {
    "test": "find src -name '*.test.ts' -exec node --import tsx --test {} +",
    "build-profile": "node --import tsx bin/build-profile.ts",
    "neighbors": "node --import tsx bin/neighbors.ts",
    "daily": "node --import tsx bin/daily.ts"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: Создать `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "types": ["node"],
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src", "bin"]
}
```

- [ ] **Step 3: Создать `.gitignore`**

```
node_modules/
.cache/
.env
```

- [ ] **Step 4: Написать проверочный тест `src/lib/smoke.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('тестовый раннер запускается', () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 5: Установить зависимости и запустить тест**

```bash
npm install && npm test
```

Ожидается: `# pass 1`, `# fail 0`.

- [ ] **Step 6: Коммит**

```bash
git add package.json package-lock.json tsconfig.json .gitignore src/lib/smoke.test.ts
git commit -m "chore: скелет проекта на Node + tsx + node:test"
```

---

## Task 2: HTTP-клиент с паузой и кэшем

Все сетевые запросы проекта идут через него. Он последовательный (никакой параллельности к Bandcamp), держит минимальную паузу между запросами и кэширует GET-страницы на диск навсегда — страница релиза не меняется, а их за жизнь проекта скачиваются тысячи.

> Реализовано с правками по итогам ревью: ретраятся только 429 и 5xx, остальные не-ok статусы падают сразу без сна (иначе каждая мёртвая ссылка стоила бы несколько секунд), тип заголовков в приватном `#send` сужен до `Record<string, string>`, добавлены тесты на ретраи, сериализацию очереди и User-Agent. Актуальный код — в `src/lib/http.ts`.

**Files:**
- Create: `src/lib/http.ts`
- Test: `src/lib/http.test.ts`

- [ ] **Step 1: Написать падающие тесты**

```ts
// src/lib/http.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Http } from './http.ts';

function fakeFetch(pages: Record<string, string>) {
  const calls: string[] = [];
  const impl = async (url: string | URL | Request, init?: RequestInit) => {
    const key = String(url);
    calls.push(key);
    const body = pages[key];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(body, { status: 200 });
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

test('getText возвращает тело страницы', async () => {
  const { impl } = fakeFetch({ 'https://x.test/a': 'hello' });
  const http = new Http({ fetchImpl: impl, minDelayMs: 0 });
  assert.equal(await http.getText('https://x.test/a'), 'hello');
});

test('кэш на диске избавляет от повторного запроса', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bc-http-'));
  const { impl, calls } = fakeFetch({ 'https://x.test/a': 'hello' });
  const http = new Http({ fetchImpl: impl, minDelayMs: 0, cacheDir: dir });
  await http.getText('https://x.test/a', { cache: true });
  const http2 = new Http({ fetchImpl: impl, minDelayMs: 0, cacheDir: dir });
  assert.equal(await http2.getText('https://x.test/a', { cache: true }), 'hello');
  assert.equal(calls.length, 1);
  await rm(dir, { recursive: true, force: true });
});

test('между запросами выдерживается пауза', async () => {
  const { impl } = fakeFetch({ 'https://x.test/a': '1', 'https://x.test/b': '2' });
  const slept: number[] = [];
  const http = new Http({
    fetchImpl: impl,
    minDelayMs: 500,
    sleep: async (ms) => { slept.push(ms); },
    now: (() => { let t = 0; return () => (t += 10); })(),
  });
  await http.getText('https://x.test/a');
  await http.getText('https://x.test/b');
  assert.ok(slept.some((ms) => ms > 0), `ожидалась пауза, получено ${JSON.stringify(slept)}`);
});

test('404 приводит к ошибке с URL в тексте', async () => {
  const { impl } = fakeFetch({});
  const http = new Http({ fetchImpl: impl, minDelayMs: 0, retries: 0 });
  await assert.rejects(() => http.getText('https://x.test/missing'), /missing/);
});

test('postJson отдаёт разобранный JSON', async () => {
  const impl = (async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch;
  const http = new Http({ fetchImpl: impl, minDelayMs: 0 });
  assert.deepEqual(await http.postJson('https://x.test/api', { a: 1 }), { ok: true });
});
```

- [ ] **Step 2: Запустить тесты и убедиться, что падают**

```bash
npm test
```

Ожидается: `Cannot find module './http.ts'`.

- [ ] **Step 3: Реализовать `src/lib/http.ts`**

```ts
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const USER_AGENT =
  'bandcamp-daily/1.0 (personal listening recommender; contact: github.com/MishaKolotov/bandcamp-daily)';

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

  async #send(url: string, init: RequestInit): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#retries; attempt += 1) {
      await this.#throttle();
      try {
        const response = await this.#fetch(url, {
          ...init,
          headers: { 'User-Agent': USER_AGENT, ...(init.headers ?? {}) },
        });
        if (response.status === 429 || response.status >= 500) {
          throw new Error(`bandcamp ответил ${response.status} на ${url}`);
        }
        if (!response.ok) throw new Error(`bandcamp ответил ${response.status} на ${url}`);
        return await response.text();
      } catch (error) {
        lastError = error;
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
```

- [ ] **Step 4: Запустить тесты**

```bash
npm test
```

Ожидается: все тесты `http.test.ts` проходят.

- [ ] **Step 5: Коммит**

```bash
git add src/lib/http.ts src/lib/http.test.ts
git commit -m "feat: HTTP-клиент с очередью, паузой и дисковым кэшем"
```

---

## Task 3: Хранилище состояния

**Files:**
- Create: `src/lib/state.ts`
- Test: `src/lib/state.test.ts`

- [ ] **Step 1: Написать падающие тесты**

```ts
// src/lib/state.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJson } from './state.ts';

test('чтение отсутствующего файла возвращает значение по умолчанию', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bc-state-'));
  assert.deepEqual(await readJson(join(dir, 'nope.json'), { seen: [] }), { seen: [] });
  await rm(dir, { recursive: true, force: true });
});

test('запись и чтение возвращают то же значение', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bc-state-'));
  const path = join(dir, 'a/b/seen.json');
  await writeJson(path, { seen: [1, 2] });
  assert.deepEqual(await readJson(path, { seen: [] as number[] }), { seen: [1, 2] });
  await rm(dir, { recursive: true, force: true });
});

test('файл пишется с отступами и переводом строки в конце — чтобы дифф в git читался', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bc-state-'));
  const path = join(dir, 'x.json');
  await writeJson(path, { a: 1 });
  const raw = await readFile(path, 'utf8');
  assert.equal(raw, '{\n  "a": 1\n}\n');
  await rm(dir, { recursive: true, force: true });
});

test('битый JSON не роняет запуск, а откатывается к умолчанию', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bc-state-'));
  const path = join(dir, 'broken.json');
  await writeJson(path, { a: 1 });
  await (await import('node:fs/promises')).writeFile(path, '{oops', 'utf8');
  assert.deepEqual(await readJson(path, { a: 0 }), { a: 0 });
  await rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Запустить тесты и убедиться, что падают**

```bash
npm test
```

Ожидается: `Cannot find module './state.ts'`.

- [ ] **Step 3: Реализовать `src/lib/state.ts`**

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
```

- [ ] **Step 4: Запустить тесты**

```bash
npm test
```

Ожидается: все тесты `state.test.ts` проходят.

- [ ] **Step 5: Коммит**

```bash
git add src/lib/state.ts src/lib/state.test.ts
git commit -m "feat: чтение и запись файлов состояния"
```

---

## Task 4: Типы предметной области

**Files:**
- Create: `src/bandcamp/types.ts`

- [ ] **Step 1: Написать `src/bandcamp/types.ts`**

Тестов нет — файл содержит только типы, проверяется компилятором на следующих задачах.

```ts
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
```

- [ ] **Step 2: Проверить, что типы компилируются**

```bash
npx tsc --noEmit
```

Ожидается: вывод пустой, код возврата 0.

- [ ] **Step 3: Коммит**

```bash
git add src/bandcamp/types.ts
git commit -m "feat: типы предметной области"
```

---

## Task 5: Парсер страницы релиза

Единственный источник тегов и даты релиза. Берём из `ld+json` — это стабильный машинный формат, в отличие от вёрстки.

**Files:**
- Create: `src/bandcamp/album.ts`, `test/fixtures/album-degraved.html`
- Test: `src/bandcamp/album.test.ts`

- [ ] **Step 1: Сохранить фикстуру**

```bash
mkdir -p test/fixtures
curl -sL -A "Mozilla/5.0" "https://degraved.bandcamp.com/album/exhumed-remnants-2" -o test/fixtures/album-degraved.html
grep -c 'application/ld+json' test/fixtures/album-degraved.html
```

Ожидается: `1` или больше.

- [ ] **Step 2: Написать падающие тесты**

```ts
// src/bandcamp/album.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseAlbumPage } from './album.ts';

const fixture = await readFile('test/fixtures/album-degraved.html', 'utf8');

test('вытаскивает название, артиста и лейбл', () => {
  const album = parseAlbumPage(fixture);
  assert.equal(album.title, 'Exhumed Remnants');
  assert.equal(album.artist, 'Degraved');
  assert.equal(album.label, 'Degraved');
});

test('теги приводятся к нижнему регистру', () => {
  const album = parseAlbumPage(fixture);
  assert.ok(album.tags.includes('death metal'));
  assert.ok(album.tags.includes('osdm'));
  assert.ok(!album.tags.some((t) => /[A-Z]/.test(t)), 'нашлись теги с заглавными буквами');
});

test('дата релиза переводится в ISO', () => {
  const album = parseAlbumPage(fixture);
  assert.equal(album.releasedAt, '2021-03-19');
});

test('обложка вытаскивается', () => {
  assert.match(parseAlbumPage(fixture).artUrl ?? '', /^https:\/\/f4\.bcbits\.com\/img\//);
});

test('страница без ld+json даёт понятную ошибку', () => {
  assert.throws(() => parseAlbumPage('<html><body>ничего</body></html>'), /ld\+json/);
});

test('отсутствующие необязательные поля не роняют парсер', () => {
  const minimal = `<script type="application/ld+json">${JSON.stringify({
    name: 'X',
    byArtist: { name: 'Y' },
  })}</script>`;
  const album = parseAlbumPage(minimal);
  assert.deepEqual(album, {
    title: 'X',
    artist: 'Y',
    label: null,
    tags: [],
    releasedAt: null,
    artUrl: null,
  });
});
```

- [ ] **Step 3: Запустить тесты и убедиться, что падают**

```bash
npm test
```

Ожидается: `Cannot find module './album.ts'`.

- [ ] **Step 4: Реализовать `src/bandcamp/album.ts`**

```ts
import type { Http } from '../lib/http.ts';
import type { AlbumDetails } from './types.ts';

interface LdJson {
  name?: string;
  byArtist?: { name?: string };
  publisher?: { name?: string };
  keywords?: string[];
  datePublished?: string;
  image?: string;
}

/** Bandcamp отдаёт даты как "19 Mar 2021 00:00:00 GMT". Приводим к YYYY-MM-DD. */
function toIsoDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

export function parseAlbumPage(html: string): AlbumDetails {
  const match = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  if (!match?.[1]) throw new Error('на странице релиза нет блока ld+json');
  let data: LdJson;
  try {
    data = JSON.parse(match[1]) as LdJson;
  } catch {
    throw new Error('блок ld+json на странице релиза не разобрался');
  }
  return {
    title: data.name ?? '',
    artist: data.byArtist?.name ?? '',
    label: data.publisher?.name ?? null,
    tags: (data.keywords ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean),
    releasedAt: toIsoDate(data.datePublished),
    artUrl: data.image ?? null,
  };
}

/**
 * Страница релиза не меняется, поэтому кэшируется навсегда.
 * Возвращает null, если страница недоступна или не разобралась — один битый
 * релиз не должен ронять весь запуск.
 */
export async function fetchAlbum(http: Http, url: string): Promise<AlbumDetails | null> {
  try {
    return parseAlbumPage(await http.getText(url, { cache: true }));
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Запустить тесты**

```bash
npm test
```

Ожидается: все тесты `album.test.ts` проходят.

- [ ] **Step 6: Коммит**

```bash
git add src/bandcamp/album.ts src/bandcamp/album.test.ts test/fixtures/album-degraved.html
git commit -m "feat: парсер страницы релиза через ld+json"
```

---

## Task 6: Коллекция, вишлист и подписки фаната

**Files:**
- Create: `src/bandcamp/fan.ts`
- Test: `src/bandcamp/fan.test.ts`

- [ ] **Step 1: Написать падающие тесты**

```ts
// src/bandcamp/fan.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Http } from '../lib/http.ts';
import { fetchFanItems, fetchFollowedBands } from './fan.ts';

function apiStub(responses: unknown[]) {
  const bodies: unknown[] = [];
  let index = 0;
  const impl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const payload = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as unknown as typeof fetch;
  return { http: new Http({ fetchImpl: impl, minDelayMs: 0 }), bodies };
}

const item = (id: number) => ({
  item_id: id,
  band_id: 100 + id,
  item_title: `Album ${id}`,
  band_name: `Band ${id}`,
  item_url: `https://label${id}.bandcamp.com/album/a${id}`,
  url_hints: { subdomain: `label${id}` },
  also_collected_count: id,
  added: '31 Jul 2026 21:52:06 GMT',
});

test('коллекция собирается со всех страниц', async () => {
  const { http, bodies } = apiStub([
    { items: [item(1), item(2)], more_available: true, last_token: 'TOKEN-2' },
    { items: [item(3)], more_available: false, last_token: null },
  ]);
  const items = await fetchFanItems(http, 7566215, 'collection');
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((i) => i.itemId), [1, 2, 3]);
  assert.equal((bodies[0] as { older_than_token: string }).older_than_token, '9999999999::a::');
  assert.equal((bodies[1] as { older_than_token: string }).older_than_token, 'TOKEN-2');
});

test('поля раскладываются в доменную структуру', async () => {
  const { http } = apiStub([{ items: [item(7)], more_available: false, last_token: null }]);
  const [first] = await fetchFanItems(http, 7566215, 'collection');
  assert.deepEqual(first, {
    itemId: 7,
    bandId: 107,
    title: 'Album 7',
    artist: 'Band 7',
    url: 'https://label7.bandcamp.com/album/a7',
    subdomain: 'label7',
    alsoCollected: 7,
    addedAt: '2026-07-31',
    source: 'collection',
  });
});

test('вишлист ходит в свой эндпоинт и помечается источником', async () => {
  const urls: string[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    urls.push(String(url));
    return new Response(
      JSON.stringify({ items: [item(1)], more_available: false, last_token: null }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const http = new Http({ fetchImpl: impl, minDelayMs: 0 });
  const [first] = await fetchFanItems(http, 1, 'wishlist');
  assert.match(urls[0] ?? '', /wishlist_items$/);
  assert.equal(first?.source, 'wishlist');
});

test('подписки читаются из ключа followeers', async () => {
  const { http } = apiStub([
    {
      followeers: [
        {
          band_id: 3398914009,
          name: 'Anesthetic',
          location: 'Omaha, Nebraska',
          url_hints: { subdomain: 'anesthetic402' },
        },
      ],
      more_available: false,
      last_token: null,
    },
  ]);
  assert.deepEqual(await fetchFollowedBands(http, 1), [
    {
      bandId: 3398914009,
      name: 'Anesthetic',
      subdomain: 'anesthetic402',
      location: 'Omaha, Nebraska',
    },
  ]);
});

test('бесконечная пагинация обрывается лимитом страниц', async () => {
  const { http, bodies } = apiStub([
    { items: [item(1)], more_available: true, last_token: 'SAME' },
  ]);
  const items = await fetchFanItems(http, 1, 'collection');
  assert.ok(bodies.length <= 60, `страниц запрошено ${bodies.length}`);
  assert.ok(items.length > 0);
});
```

- [ ] **Step 2: Запустить тесты и убедиться, что падают**

```bash
npm test
```

Ожидается: `Cannot find module './fan.ts'`.

- [ ] **Step 3: Реализовать `src/bandcamp/fan.ts`**

```ts
import type { Http } from '../lib/http.ts';
import type { BandRef, FanItem } from './types.ts';

const API = 'https://bandcamp.com/api/fancollection/1';
/** Токен «от начала времён»: с ним первая страница отдаёт самые свежие позиции. */
const START_TOKEN = '9999999999::a::';
const PAGE_SIZE = 100;
const MAX_PAGES = 60;

interface RawItem {
  item_id: number;
  band_id: number;
  item_title?: string;
  band_name?: string;
  item_url?: string;
  url_hints?: { subdomain?: string };
  also_collected_count?: number;
  added?: string;
}

interface ItemsPage {
  items?: RawItem[];
  followeers?: RawBand[];
  more_available?: boolean;
  last_token?: string | null;
}

interface RawBand {
  band_id: number;
  name?: string;
  location?: string | null;
  url_hints?: { subdomain?: string };
}

function toIsoDate(raw: string | undefined): string {
  const parsed = new Date(raw ?? '');
  return Number.isNaN(parsed.getTime()) ? '1970-01-01' : parsed.toISOString().slice(0, 10);
}

async function pages(
  http: Http,
  endpoint: string,
  fanId: number,
): Promise<ItemsPage[]> {
  const result: ItemsPage[] = [];
  let token = START_TOKEN;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await http.postJson<ItemsPage>(`${API}/${endpoint}`, {
      fan_id: fanId,
      older_than_token: token,
      count: PAGE_SIZE,
    });
    result.push(body);
    const next = body.last_token;
    // Bandcamp иногда повторяет тот же токен — это конец, а не бесконечность.
    if (!body.more_available || !next || next === token) break;
    token = next;
  }
  return result;
}

export async function fetchFanItems(
  http: Http,
  fanId: number,
  source: 'collection' | 'wishlist',
): Promise<FanItem[]> {
  const endpoint = source === 'collection' ? 'collection_items' : 'wishlist_items';
  const raw = (await pages(http, endpoint, fanId)).flatMap((page) => page.items ?? []);
  return raw.map((item) => ({
    itemId: item.item_id,
    bandId: item.band_id,
    title: item.item_title ?? '',
    artist: item.band_name ?? '',
    url: item.item_url ?? '',
    subdomain: item.url_hints?.subdomain ?? '',
    alsoCollected: item.also_collected_count ?? 0,
    addedAt: toIsoDate(item.added),
    source,
  }));
}

export async function fetchFollowedBands(http: Http, fanId: number): Promise<BandRef[]> {
  const raw = (await pages(http, 'following_bands', fanId)).flatMap((page) => page.followeers ?? []);
  return raw.map((band) => ({
    bandId: band.band_id,
    name: band.name ?? '',
    subdomain: band.url_hints?.subdomain ?? '',
    location: band.location ?? null,
  }));
}
```

- [ ] **Step 4: Запустить тесты**

```bash
npm test
```

Ожидается: все тесты `fan.test.ts` проходят.

- [ ] **Step 5: Проверить на живом Bandcamp**

```bash
node --import tsx -e "import {Http} from './src/lib/http.ts';import {fetchFanItems,fetchFollowedBands} from './src/bandcamp/fan.ts';const h=new Http({minDelayMs:800});console.log('коллекция',(await fetchFanItems(h,7566215,'collection')).length);console.log('вишлист',(await fetchFanItems(h,7566215,'wishlist')).length);console.log('подписки',(await fetchFollowedBands(h,7566215)).length)"
```

Ожидается: коллекция примерно 223, подписки примерно 45. Если коллекция вернула 20 или 100 — сломана пагинация, чинить до перехода дальше.

- [ ] **Step 6: Коммит**

```bash
git add src/bandcamp/fan.ts src/bandcamp/fan.test.ts
git commit -m "feat: чтение коллекции, вишлиста и подписок фаната"
```

---

## Task 7: Тег-хабы Discover

**Files:**
- Create: `src/bandcamp/discover.ts`
- Test: `src/bandcamp/discover.test.ts`

- [ ] **Step 1: Написать падающие тесты**

```ts
// src/bandcamp/discover.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Http } from '../lib/http.ts';
import { discover } from './discover.ts';

function stub(payload: unknown) {
  const bodies: unknown[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as unknown as typeof fetch;
  return { http: new Http({ fetchImpl: impl, minDelayMs: 0 }), bodies };
}

const result = {
  item_id: 2309993853,
  item_type: 'a',
  title: 'Rush',
  item_url: 'https://rebel-base-ngt.bandcamp.com/album/-?from=discover_page',
  band_name: 'ngt.',
  band_location: 'Japan',
};

test('тег и слайс уходят в тело запроса', async () => {
  const { http, bodies } = stub({ results: [result] });
  await discover(http, { tag: 'crust', slice: 'new', size: 40 });
  assert.deepEqual(bodies[0], {
    category_id: 0,
    tag_norm_names: ['crust'],
    geoname_id: 0,
    slice: 'new',
    time_facet_id: null,
    size: 40,
    cursor: '*',
    include_result_types: ['a'],
  });
});

test('служебный from=discover_page отрезается от ссылки', async () => {
  const { http } = stub({ results: [result] });
  const [first] = await discover(http, { tag: 'crust', slice: 'new' });
  assert.equal(first?.url, 'https://rebel-base-ngt.bandcamp.com/album/-');
});

test('пустой ответ отдаёт пустой список, а не падение', async () => {
  const { http } = stub({ results: [] });
  assert.deepEqual(await discover(http, { tag: 'crust', slice: 'new' }), []);
});

test('ответ с ошибкой отдаёт пустой список', async () => {
  const { http } = stub({ error: true, error_message: 'bad function' });
  assert.deepEqual(await discover(http, { tag: 'crust', slice: 'new' }), []);
});
```

- [ ] **Step 2: Запустить тесты и убедиться, что падают**

```bash
npm test
```

Ожидается: `Cannot find module './discover.ts'`.

- [ ] **Step 3: Реализовать `src/bandcamp/discover.ts`**

```ts
import type { Http } from '../lib/http.ts';

const ENDPOINT = 'https://bandcamp.com/api/discover/1/discover_web';

export interface DiscoverItem {
  itemId: number;
  url: string;
  title: string;
  artist: string;
  location: string | null;
}

export interface DiscoverOptions {
  tag: string;
  /** new — новинки, top — продаваемое, rand — случайное. */
  slice: 'new' | 'top' | 'rand';
  size?: number;
}

interface RawResult {
  item_id: number;
  item_url?: string;
  title?: string;
  band_name?: string;
  band_location?: string | null;
}

export async function discover(http: Http, options: DiscoverOptions): Promise<DiscoverItem[]> {
  const body = await http.postJson<{ results?: RawResult[] }>(ENDPOINT, {
    category_id: 0,
    tag_norm_names: [options.tag],
    geoname_id: 0,
    slice: options.slice,
    time_facet_id: null,
    size: options.size ?? 60,
    cursor: '*',
    include_result_types: ['a'],
  });
  return (body.results ?? []).map((item) => ({
    itemId: item.item_id,
    url: (item.item_url ?? '').split('?')[0] ?? '',
    title: item.title ?? '',
    artist: item.band_name ?? '',
    location: item.band_location ?? null,
  }));
}
```

- [ ] **Step 4: Запустить тесты**

```bash
npm test
```

Ожидается: все тесты `discover.test.ts` проходят.

- [ ] **Step 5: Коммит**

```bash
git add src/bandcamp/discover.ts src/bandcamp/discover.test.ts
git commit -m "feat: клиент тег-хабов Discover"
```

---

## Task 8: Коллекционеры релиза и дискография группы

**Files:**
- Create: `src/bandcamp/collectors.ts`, `src/bandcamp/band.ts`, `test/fixtures/music-grid.html`
- Test: `src/bandcamp/band.test.ts`, `src/bandcamp/collectors.test.ts`

- [ ] **Step 1: Сохранить фикстуру страницы дискографии**

```bash
curl -sL -A "Mozilla/5.0" "https://lavidaesunmus.bandcamp.com/music" -o test/fixtures/music-grid.html
grep -c 'music-grid' test/fixtures/music-grid.html
```

Ожидается: число больше нуля.

- [ ] **Step 2: Написать падающие тесты**

```ts
// src/bandcamp/collectors.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Http } from '../lib/http.ts';
import { fetchCollectors } from './collectors.ts';

test('возвращает fan_id купивших релиз', async () => {
  const impl = (async () =>
    new Response(
      JSON.stringify({
        results: [
          { fan_id: 7566215, username: 'gigamike666' },
          { fan_id: 42, username: 'someone' },
        ],
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  const http = new Http({ fetchImpl: impl, minDelayMs: 0 });
  assert.deepEqual(await fetchCollectors(http, 2720727045), [7566215, 42]);
});

test('ошибка сети даёт пустой список, а не исключение', async () => {
  const impl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
  const http = new Http({ fetchImpl: impl, minDelayMs: 0, retries: 0 });
  assert.deepEqual(await fetchCollectors(http, 1), []);
});
```

```ts
// src/bandcamp/band.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseMusicGrid } from './band.ts';

const fixture = await readFile('test/fixtures/music-grid.html', 'utf8');

test('дискография разбирается в список ссылок', () => {
  const releases = parseMusicGrid(fixture, 'lavidaesunmus');
  assert.ok(releases.length > 10, `разобрано ${releases.length} релизов`);
  assert.match(releases[0]?.url ?? '', /^https:\/\/lavidaesunmus\.bandcamp\.com\/album\//);
  assert.ok((releases[0]?.title ?? '').length > 0);
});

test('страница без грида (у группы один релиз) даёт пустой список', () => {
  assert.deepEqual(parseMusicGrid('<html><body>один альбом</body></html>', 'x'), []);
});

test('треки-синглы отбрасываются, остаются альбомы', () => {
  const grid = `<ol id="music-grid" data-client-items="${JSON.stringify([
    { id: 1, title: 'A', artist: 'X', page_url: '/album/a', type: 'album' },
    { id: 2, title: 'B', artist: 'X', page_url: '/track/b', type: 'track' },
  ])
    .replaceAll('"', '&quot;')}"></ol>`;
  const releases = parseMusicGrid(grid, 'x');
  assert.deepEqual(releases.map((r) => r.url), ['https://x.bandcamp.com/album/a']);
});
```

- [ ] **Step 3: Запустить тесты и убедиться, что падают**

```bash
npm test
```

Ожидается: `Cannot find module './collectors.ts'` и `'./band.ts'`.

- [ ] **Step 4: Реализовать `src/bandcamp/collectors.ts`**

```ts
import type { Http } from '../lib/http.ts';

const ENDPOINT = 'https://bandcamp.com/api/tralbumcollectors/2/thumbs';

/** fan_id тех, у кого этот релиз в коллекции. Вход в граф соседей по вкусу. */
export async function fetchCollectors(
  http: Http,
  albumId: number,
  count = 40,
): Promise<number[]> {
  try {
    const body = await http.postJson<{ results?: { fan_id: number }[] }>(ENDPOINT, {
      tralbum_type: 'a',
      tralbum_id: albumId,
      count,
    });
    return (body.results ?? []).map((fan) => fan.fan_id);
  } catch {
    return [];
  }
}
```

- [ ] **Step 5: Реализовать `src/bandcamp/band.ts`**

```ts
import type { Http } from '../lib/http.ts';

export interface BandRelease {
  url: string;
  title: string;
}

interface GridItem {
  title?: string;
  page_url?: string;
  type?: string;
}

function decodeEntities(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

/**
 * Дискография лежит в атрибуте data-client-items у <ol id="music-grid">,
 * новые релизы идут первыми. У групп с единственным релизом грида нет —
 * это не ошибка, просто возвращаем пустой список.
 */
export function parseMusicGrid(html: string, subdomain: string): BandRelease[] {
  const match = /<ol[^>]*id="music-grid"[^>]*data-client-items="([^"]*)"/.exec(html);
  if (!match?.[1]) return [];
  let items: GridItem[];
  try {
    items = JSON.parse(decodeEntities(match[1])) as GridItem[];
  } catch {
    return [];
  }
  return items
    .filter((item) => item.type === 'album' && item.page_url?.startsWith('/album/'))
    .map((item) => ({
      url: `https://${subdomain}.bandcamp.com${item.page_url}`,
      title: item.title ?? '',
    }));
}

/**
 * Свежие релизы группы. Берём только начало грида: дискографии бывают
 * по несколько сотен позиций, а нам нужны новинки.
 */
export async function fetchBandReleases(
  http: Http,
  subdomain: string,
  limit = 8,
): Promise<BandRelease[]> {
  try {
    const html = await http.getText(`https://${subdomain}.bandcamp.com/music`);
    return parseMusicGrid(html, subdomain).slice(0, limit);
  } catch {
    return [];
  }
}
```

- [ ] **Step 6: Запустить тесты**

```bash
npm test
```

Ожидается: все тесты `band.test.ts` и `collectors.test.ts` проходят.

- [ ] **Step 7: Коммит**

```bash
git add src/bandcamp/collectors.ts src/bandcamp/band.ts src/bandcamp/*.test.ts test/fixtures/music-grid.html
git commit -m "feat: коллекционеры релиза и дискография группы"
```

---

## Task 9: Определение бакетов

> Реализовано с двумя правками по итогам ревью. Первая: голые теги `hardcore` и `punk` убраны из seed-списка — на Bandcamp это омонимы (electronic hardcore, поп-панк, скейт-панк), они затаскивали бы в бакет посторонние релизы. Вторая, важнее: `bucketOf` (один бакет-победитель) заменён на `bucketsOf` — релиз питает статистику **всех** бакетов, чьи seed-теги совпали. Статистики бакетов независимы, общего бюджета нет, а кроссовер crust/hardcore в этой коллекции обычное дело: при выборе одного победителя такие релизы целиком уходили в краст и обесточивали хардкор-бакет. Задачи 10 и далее используют `bucketsOf` и цикл по всем совпавшим бакетам.

**Files:**
- Create: `src/profile/buckets.ts`
- Test: `src/profile/buckets.test.ts`

- [ ] **Step 1: Написать падающие тесты**

```ts
// src/profile/buckets.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUCKETS, bucketOf } from './buckets.ts';

test('описаны ровно три бакета с каналами', () => {
  assert.deepEqual(
    BUCKETS.map((b) => b.id),
    ['crust', 'death-metal', 'hardcore-punk'],
  );
  for (const bucket of BUCKETS) {
    assert.ok(bucket.channelEnv.endsWith('_CHANNEL_ID'), bucket.channelEnv);
    assert.ok(bucket.seedTags.length >= 3, `${bucket.id}: мало seed-тегов`);
  }
});

test('релиз попадает в бакет по seed-тегу', () => {
  assert.equal(bucketOf(['d-beat', 'crust punk']), 'crust');
  assert.equal(bucketOf(['old school death metal', 'osdm']), 'death-metal');
  assert.equal(bucketOf(['hardcore punk', 'oi']), 'hardcore-punk');
});

test('релиз без seed-тегов не попадает никуда', () => {
  assert.equal(bucketOf(['ambient', 'drone']), null);
});

test('при попадании в несколько бакетов побеждает тот, где больше совпадений', () => {
  assert.equal(bucketOf(['crust', 'crust punk', 'd-beat', 'death metal']), 'crust');
});
```

- [ ] **Step 2: Запустить тесты и убедиться, что падают**

```bash
npm test
```

Ожидается: `Cannot find module './buckets.ts'`.

- [ ] **Step 3: Реализовать `src/profile/buckets.ts`**

```ts
import type { BucketId } from '../bandcamp/types.ts';

export interface BucketDef {
  id: BucketId;
  /** Человекочитаемое имя канала — уходит в текст поста. */
  channelTitle: string;
  /** Имя переменной окружения с chat_id канала. */
  channelEnv: string;
  /**
   * Опорные теги: по ним релиз из коллекции относится к бакету.
   * Остальные веса тегов вычисляются из данных, эти заданы вручную.
   */
  seedTags: string[];
}

export const BUCKETS: BucketDef[] = [
  {
    id: 'crust',
    channelTitle: 'CRUST DAILY',
    channelEnv: 'CRUST_CHANNEL_ID',
    seedTags: ['crust', 'crust punk', 'crustpunk', 'd-beat', 'dbeat', 'stenchcore', 'neocrust'],
  },
  {
    id: 'death-metal',
    channelTitle: 'DEATH METAL DAILY',
    channelEnv: 'DEATH_METAL_CHANNEL_ID',
    seedTags: [
      'death metal',
      'osdm',
      'old school death metal',
      'death-doom',
      'death doom',
      'brutal death metal',
    ],
  },
  {
    id: 'hardcore-punk',
    channelTitle: 'HARDCORE PUNK DAILY',
    channelEnv: 'HARDCORE_PUNK_CHANNEL_ID',
    seedTags: ['hardcore punk', 'hardcore', 'powerviolence', 'punk', 'raw punk', 'ukhc'],
  },
];

/** Бакет релиза: тот, чьих seed-тегов совпало больше. Ничьи разрешаются порядком BUCKETS. */
export function bucketOf(tags: string[]): BucketId | null {
  const normalized = new Set(tags.map((tag) => tag.toLowerCase()));
  let best: { id: BucketId; hits: number } | null = null;
  for (const bucket of BUCKETS) {
    const hits = bucket.seedTags.filter((tag) => normalized.has(tag)).length;
    if (hits > 0 && (best === null || hits > best.hits)) best = { id: bucket.id, hits };
  }
  return best?.id ?? null;
}
```

- [ ] **Step 4: Запустить тесты**

```bash
npm test
```

Ожидается: все тесты `buckets.test.ts` проходят.

- [ ] **Step 5: Коммит**

```bash
git add src/profile/buckets.ts src/profile/buckets.test.ts
git commit -m "feat: определение трёх жанровых бакетов"
```

---

## Task 10: Построение профиля вкуса

Чистая агрегация: на вход список релизов с тегами, на выход веса. Сеть в этом файле не трогаем — её делает `bin/build-profile.ts` в задаче 15.

**Files:**
- Create: `src/profile/build.ts`
- Test: `src/profile/build.test.ts`

- [ ] **Step 1: Написать падающие тесты**

```ts
// src/profile/build.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProfile, type ProfileInput } from './build.ts';

const release = (over: Partial<ProfileInput>): ProfileInput => ({
  tags: [],
  label: null,
  addedAt: '2020-01-01',
  source: 'collection',
  ...over,
});

test('теги релизов бакета попадают в его веса', () => {
  const profile = buildProfile(
    [
      release({ tags: ['crust', 'd-beat', 'raw'] }),
      release({ tags: ['crust', 'd-beat'] }),
      release({ tags: ['death metal', 'osdm'] }),
      release({ tags: ['death metal', 'osdm'] }),
    ],
    { now: new Date('2026-08-03'), minReleases: 2 },
  );
  assert.ok(profile.buckets.crust.tags['d-beat']! > 0);
  assert.ok(profile.buckets['death-metal'].tags['osdm']! > 0);
  assert.equal(profile.buckets.crust.tags['osdm'], undefined);
});

test('вес самого частого тега бакета равен единице', () => {
  const profile = buildProfile(
    [release({ tags: ['crust', 'd-beat'] }), release({ tags: ['crust'] })],
    { now: new Date('2026-08-03'), minReleases: 1 },
  );
  assert.equal(Math.max(...Object.values(profile.buckets.crust.tags)), 1);
});

test('редкий тег отбрасывается порогом minReleases', () => {
  const profile = buildProfile(
    [
      release({ tags: ['crust', 'd-beat'] }),
      release({ tags: ['crust', 'd-beat'] }),
      release({ tags: ['crust', 'случайность'] }),
    ],
    { now: new Date('2026-08-03'), minReleases: 2 },
  );
  assert.equal(profile.buckets.crust.tags['случайность'], undefined);
});

test('вишлист и свежие покупки весят больше старых', () => {
  const old = buildProfile([release({ tags: ['crust', 'старое'], addedAt: '2019-01-01' })], {
    now: new Date('2026-08-03'),
    minReleases: 1,
  });
  const fresh = buildProfile(
    [release({ tags: ['crust', 'новое'], addedAt: '2026-07-01', source: 'wishlist' })],
    { now: new Date('2026-08-03'), minReleases: 1 },
  );
  assert.ok(fresh.buckets.crust.releaseCount >= old.buckets.crust.releaseCount);
  assert.ok(fresh.buckets.crust.weightSum > old.buckets.crust.weightSum);
});

test('лейблы считаются по всем релизам сразу', () => {
  const profile = buildProfile(
    [
      release({ tags: ['crust'], label: 'La Vida Es Un Mus' }),
      release({ tags: ['death metal'], label: 'La Vida Es Un Mus' }),
      release({ tags: ['crust'], label: 'Одиночка' }),
    ],
    { now: new Date('2026-08-03'), minReleases: 1 },
  );
  assert.equal(Math.max(...Object.values(profile.labels)), 1);
  assert.ok(profile.labels['la vida es un mus']! > (profile.labels['одиночка'] ?? 0));
});

test('релизы вне трёх жанров игнорируются', () => {
  const profile = buildProfile([release({ tags: ['ambient'] })], {
    now: new Date('2026-08-03'),
    minReleases: 1,
  });
  assert.equal(profile.buckets.crust.releaseCount, 0);
});
```

- [ ] **Step 2: Запустить тесты и убедиться, что падают**

```bash
npm test
```

Ожидается: `Cannot find module './build.ts'`.

- [ ] **Step 3: Реализовать `src/profile/build.ts`**

```ts
import type { BucketId } from '../bandcamp/types.ts';
import { BUCKETS, bucketOf } from './buckets.ts';

export interface ProfileInput {
  tags: string[];
  label: string | null;
  addedAt: string;
  source: 'collection' | 'wishlist';
}

export interface BucketProfile {
  /** Тег → вес 0..1, где 1 у самого характерного тега бакета. */
  tags: Record<string, number>;
  /** Теги-исключатели, заполняются задачей 11 и правятся руками. */
  stopTags: string[];
  releaseCount: number;
  weightSum: number;
}

export interface Profile {
  generatedAt: string;
  buckets: Record<BucketId, BucketProfile>;
  labels: Record<string, number>;
}

export interface BuildOptions {
  now: Date;
  /** Тег учитывается, только если встретился минимум в стольких релизах бакета. */
  minReleases?: number;
}

/**
 * Вишлист — это «хочу сейчас», он важнее старой покупки.
 * Покупки за последний год важнее давних: вкус едет со временем.
 */
function weightOf(item: ProfileInput, now: Date): number {
  const ageDays = (now.getTime() - new Date(item.addedAt).getTime()) / 86_400_000;
  const recency = ageDays <= 365 ? 1.5 : ageDays <= 1095 ? 1.2 : 1;
  return item.source === 'wishlist' ? recency * 1.6 : recency;
}

function normalize(counts: Map<string, number>): Record<string, number> {
  const max = Math.max(0, ...counts.values());
  if (max === 0) return {};
  const result: Record<string, number> = {};
  for (const [key, value] of counts) result[key] = Number((value / max).toFixed(4));
  return result;
}

export function buildProfile(items: ProfileInput[], options: BuildOptions): Profile {
  const minReleases = options.minReleases ?? 2;

  const weighted = new Map<BucketId, Map<string, number>>();
  const documents = new Map<BucketId, Map<string, number>>();
  const stats = new Map<BucketId, { count: number; weight: number }>();
  for (const bucket of BUCKETS) {
    weighted.set(bucket.id, new Map());
    documents.set(bucket.id, new Map());
    stats.set(bucket.id, { count: 0, weight: 0 });
  }
  const labels = new Map<string, number>();

  for (const item of items) {
    const weight = weightOf(item, options.now);
    if (item.label) {
      const key = item.label.trim().toLowerCase();
      labels.set(key, (labels.get(key) ?? 0) + weight);
    }
    const bucket = bucketOf(item.tags);
    if (!bucket) continue;
    const stat = stats.get(bucket)!;
    stat.count += 1;
    stat.weight += weight;
    const tagWeights = weighted.get(bucket)!;
    const tagDocs = documents.get(bucket)!;
    for (const tag of new Set(item.tags.map((t) => t.toLowerCase()))) {
      tagWeights.set(tag, (tagWeights.get(tag) ?? 0) + weight);
      tagDocs.set(tag, (tagDocs.get(tag) ?? 0) + 1);
    }
  }

  const buckets = {} as Record<BucketId, BucketProfile>;
  for (const bucket of BUCKETS) {
    const tagWeights = weighted.get(bucket.id)!;
    const tagDocs = documents.get(bucket.id)!;
    const kept = new Map<string, number>();
    for (const [tag, weight] of tagWeights) {
      if ((tagDocs.get(tag) ?? 0) >= minReleases) kept.set(tag, weight);
    }
    const stat = stats.get(bucket.id)!;
    buckets[bucket.id] = {
      tags: normalize(kept),
      stopTags: [],
      releaseCount: stat.count,
      weightSum: Number(stat.weight.toFixed(3)),
    };
  }

  return {
    generatedAt: options.now.toISOString().slice(0, 10),
    buckets,
    labels: normalize(labels),
  };
}
```

- [ ] **Step 4: Запустить тесты**

```bash
npm test
```

Ожидается: все тесты `build.test.ts` проходят.

- [ ] **Step 5: Коммит**

```bash
git add src/profile/build.ts src/profile/build.test.ts
git commit -m "feat: построение профиля вкуса из коллекции"
```

---

## Task 11: Антипрофиль (стоп-теги)

Стоп-теги — это то, что живёт в тех же тег-хабах, но чего в коллекции владельца нет вообще. Именно они не дают дэткору просочиться в DEATH METAL DAILY.

**Files:**
- Create: `src/profile/stop-tags.ts`
- Test: `src/profile/stop-tags.test.ts`

- [ ] **Step 1: Написать падающие тесты**

```ts
// src/profile/stop-tags.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveStopTags } from './stop-tags.ts';

test('частый в хабе и отсутствующий у владельца тег становится стоп-тегом', () => {
  const stop = deriveStopTags({
    hubTagCounts: { deathcore: 12, 'death metal': 30, melodeath: 7 },
    ownedTags: new Set(['death metal', 'osdm']),
    minHubCount: 5,
  });
  assert.deepEqual(stop.sort(), ['deathcore', 'melodeath']);
});

test('тег из коллекции владельца стоп-тегом не станет никогда', () => {
  const stop = deriveStopTags({
    hubTagCounts: { osdm: 40 },
    ownedTags: new Set(['osdm']),
    minHubCount: 1,
  });
  assert.deepEqual(stop, []);
});

test('редкие в хабе теги не попадают в стоп-лист — это шум, а не жанр', () => {
  const stop = deriveStopTags({
    hubTagCounts: { 'случайное слово': 2 },
    ownedTags: new Set(),
    minHubCount: 5,
  });
  assert.deepEqual(stop, []);
});

test('стоп-лист обрезается лимитом и отсортирован по частоте', () => {
  const stop = deriveStopTags({
    hubTagCounts: { a: 100, b: 50, c: 10 },
    ownedTags: new Set(),
    minHubCount: 5,
    limit: 2,
  });
  assert.deepEqual(stop, ['a', 'b']);
});
```

- [ ] **Step 2: Запустить тесты и убедиться, что падают**

```bash
npm test
```

Ожидается: `Cannot find module './stop-tags.ts'`.

- [ ] **Step 3: Реализовать `src/profile/stop-tags.ts`**

```ts
export interface StopTagInput {
  /** Тег → сколько раз встретился среди релизов тег-хаба. */
  hubTagCounts: Record<string, number>;
  /** Все теги, встречающиеся в коллекции и вишлисте владельца. */
  ownedTags: Set<string>;
  minHubCount?: number;
  limit?: number;
}

/**
 * Стоп-тег = встречается в хабе часто, а у владельца не встречается ни разу.
 * Такие теги маркируют соседний жанр, который владелец не слушает.
 */
export function deriveStopTags(input: StopTagInput): string[] {
  const minHubCount = input.minHubCount ?? 5;
  const limit = input.limit ?? 40;
  return Object.entries(input.hubTagCounts)
    .filter(([tag, count]) => count >= minHubCount && !input.ownedTags.has(tag))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag]) => tag);
}
```

- [ ] **Step 4: Запустить тесты**

```bash
npm test
```

Ожидается: все тесты `stop-tags.test.ts` проходят.

- [ ] **Step 5: Коммит**

```bash
git add src/profile/stop-tags.ts src/profile/stop-tags.test.ts
git commit -m "feat: вывод стоп-тегов из тег-хабов"
```

---

## Task 12: Скоринг кандидата

**Files:**
- Create: `src/profile/score.ts`
- Test: `src/profile/score.test.ts`

- [ ] **Step 1: Написать падающие тесты**

```ts
// src/profile/score.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candidate } from '../bandcamp/types.ts';
import type { BucketProfile } from './build.ts';
import { score } from './score.ts';

const bucket: BucketProfile = {
  tags: { crust: 1, 'd-beat': 0.8, 'raw punk': 0.4 },
  stopTags: ['deathcore', 'metalcore'],
  releaseCount: 50,
  weightSum: 60,
};

const candidate = (over: Partial<Candidate>): Candidate => ({
  itemId: 1,
  url: 'https://x.bandcamp.com/album/a',
  title: 'A',
  artist: 'B',
  label: null,
  tags: [],
  releasedAt: '2026-08-01',
  artUrl: null,
  alsoCollected: 0,
  origin: 'fresh',
  ...over,
});

test('совпадение тегов даёт положительный скор', () => {
  const result = score(candidate({ tags: ['crust', 'd-beat'] }), bucket, {});
  assert.ok(result.total > 1.5, `скор ${result.total}`);
});

test('релиз без единого знакомого тега отбраковывается', () => {
  const result = score(candidate({ tags: ['ambient'] }), bucket, {});
  assert.equal(result.rejected, true);
});

test('стоп-тег при слабом совпадении отбраковывает релиз', () => {
  const result = score(candidate({ tags: ['raw punk', 'deathcore'] }), bucket, {});
  assert.equal(result.rejected, true);
});

test('стоп-тег при сильном совпадении только штрафует', () => {
  const strong = score(candidate({ tags: ['crust', 'd-beat', 'raw punk'] }), bucket, {});
  const withStop = score(
    candidate({ tags: ['crust', 'd-beat', 'raw punk', 'metalcore'] }),
    bucket,
    {},
  );
  assert.equal(withStop.rejected, false);
  assert.ok(withStop.total < strong.total);
});

test('знакомый лейбл поднимает скор', () => {
  const plain = score(candidate({ tags: ['crust'] }), bucket, {});
  const known = score(candidate({ tags: ['crust'], label: 'La Vida Es Un Mus' }), bucket, {
    labels: { 'la vida es un mus': 1 },
  });
  assert.ok(known.total > plain.total);
});

test('популярность добавляет мало и не перебивает совпадение по тегам', () => {
  const hype = score(candidate({ tags: ['raw punk'], alsoCollected: 5000 }), bucket, {});
  const match = score(candidate({ tags: ['crust', 'd-beat'] }), bucket, {});
  assert.ok(match.total > hype.total);
});

test('отскипанные ранее теги штрафуются', () => {
  const plain = score(candidate({ tags: ['crust'] }), bucket, {});
  const penalized = score(candidate({ tags: ['crust'] }), bucket, {
    tagPenalties: { crust: 2 },
  });
  assert.ok(penalized.total < plain.total);
});

test('в reasons попадают совпавшие теги, сильнейшие первыми', () => {
  const result = score(candidate({ tags: ['raw punk', 'crust', 'd-beat'] }), bucket, {});
  assert.deepEqual(result.reasons.slice(0, 2), ['crust', 'd-beat']);
});
```

- [ ] **Step 2: Запустить тесты и убедиться, что падают**

```bash
npm test
```

Ожидается: `Cannot find module './score.ts'`.

- [ ] **Step 3: Реализовать `src/profile/score.ts`**

```ts
import type { Candidate } from '../bandcamp/types.ts';
import type { BucketProfile } from './build.ts';

export interface ScoreContext {
  /** Лейбл → вес 0..1 из профиля. */
  labels?: Record<string, number>;
  /** Тег → сколько раз владелец скипнул релиз с этим тегом. */
  tagPenalties?: Record<string, number>;
}

export interface ScoreResult {
  total: number;
  rejected: boolean;
  /** Совпавшие теги по убыванию веса — из них строится строка «почему это тебе». */
  reasons: string[];
}

/** Минимальная сумма весов тегов, ниже которой релиз считается чужим. */
const MATCH_FLOOR = 0.5;
/** Совпадение, при котором стоп-тег уже не отбраковывает, а только штрафует. */
const STRONG_MATCH = 1.5;

export function score(
  candidate: Candidate,
  bucket: BucketProfile,
  context: ScoreContext,
): ScoreResult {
  const tags = candidate.tags.map((tag) => tag.toLowerCase());

  const matched = tags
    .map((tag) => ({ tag, weight: bucket.tags[tag] ?? 0 }))
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight);
  const tagScore = matched.reduce((sum, entry) => sum + entry.weight, 0);

  const stopHits = tags.filter((tag) => bucket.stopTags.includes(tag)).length;
  if (tagScore < MATCH_FLOOR || (stopHits > 0 && tagScore < STRONG_MATCH)) {
    return { total: 0, rejected: true, reasons: matched.map((m) => m.tag) };
  }

  const labelKey = candidate.label?.trim().toLowerCase() ?? '';
  const labelBonus = 0.7 * (context.labels?.[labelKey] ?? 0);
  const popularity = Math.min(0.5, 0.15 * Math.log10(1 + candidate.alsoCollected));
  const stopPenalty = 0.8 * stopHits;
  const feedbackPenalty = tags.reduce(
    (sum, tag) => sum + 0.25 * (context.tagPenalties?.[tag] ?? 0),
    0,
  );

  const total = tagScore + labelBonus + popularity - stopPenalty - feedbackPenalty;
  return {
    total: Number(total.toFixed(3)),
    rejected: total <= 0,
    reasons: matched.map((entry) => entry.tag),
  };
}
```

- [ ] **Step 4: Запустить тесты**

```bash
npm test
```

Ожидается: все тесты `score.test.ts` проходят.

- [ ] **Step 5: Коммит**

```bash
git add src/profile/score.ts src/profile/score.test.ts
git commit -m "feat: скоринг кандидата по профилю бакета"
```

---

## Task 13: Кандидаты-новинки

**Files:**
- Create: `src/pipeline/fresh.ts`
- Test: `src/pipeline/fresh.test.ts`

- [ ] **Step 1: Написать падающие тесты**

```ts
// src/pipeline/fresh.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AlbumDetails } from '../bandcamp/types.ts';
import { freshCandidates, type FreshDeps } from './fresh.ts';

const album = (over: Partial<AlbumDetails>): AlbumDetails => ({
  title: 'A',
  artist: 'B',
  label: null,
  tags: ['crust'],
  releasedAt: '2026-08-01',
  artUrl: null,
  ...over,
});

function deps(over: Partial<FreshDeps> = {}): FreshDeps {
  return {
    discover: async () => [],
    bandReleases: async () => [],
    album: async () => album({}),
    ...over,
  };
}

test('релизы из хаба и от подписок объединяются', async () => {
  const found = await freshCandidates(
    deps({
      discover: async () => [{ itemId: 1, url: 'https://a.test/album/1', title: 'A', artist: 'X', location: null }],
      bandReleases: async () => [{ url: 'https://b.test/album/2', title: 'B' }],
    }),
    { tags: ['crust'], subdomains: ['b'], now: new Date('2026-08-03'), maxAgeDays: 7 },
  );
  assert.deepEqual(found.map((c) => c.url).sort(), ['https://a.test/album/1', 'https://b.test/album/2']);
});

test('старые релизы отсекаются по дате', async () => {
  const found = await freshCandidates(
    deps({
      discover: async () => [{ itemId: 1, url: 'https://a.test/album/1', title: 'A', artist: 'X', location: null }],
      album: async () => album({ releasedAt: '2020-01-01' }),
    }),
    { tags: ['crust'], subdomains: [], now: new Date('2026-08-03'), maxAgeDays: 7 },
  );
  assert.deepEqual(found, []);
});

test('релиз без даты не проходит — дату проверить нечем', async () => {
  const found = await freshCandidates(
    deps({
      discover: async () => [{ itemId: 1, url: 'https://a.test/album/1', title: 'A', artist: 'X', location: null }],
      album: async () => album({ releasedAt: null }),
    }),
    { tags: ['crust'], subdomains: [], now: new Date('2026-08-03'), maxAgeDays: 7 },
  );
  assert.deepEqual(found, []);
});

test('предзаказ с датой в будущем считается свежим', async () => {
  const found = await freshCandidates(
    deps({
      discover: async () => [{ itemId: 1, url: 'https://a.test/album/1', title: 'A', artist: 'X', location: null }],
      album: async () => album({ releasedAt: '2026-09-01' }),
    }),
    { tags: ['crust'], subdomains: [], now: new Date('2026-08-03'), maxAgeDays: 7 },
  );
  assert.equal(found.length, 1);
});

test('один и тот же релиз из двух источников не дублируется', async () => {
  const found = await freshCandidates(
    deps({
      discover: async () => [{ itemId: 1, url: 'https://a.test/album/1', title: 'A', artist: 'X', location: null }],
      bandReleases: async () => [{ url: 'https://a.test/album/1', title: 'A' }],
    }),
    { tags: ['crust'], subdomains: ['a'], now: new Date('2026-08-03'), maxAgeDays: 7 },
  );
  assert.equal(found.length, 1);
});

test('нечитаемая страница релиза просто выбрасывает кандидата', async () => {
  const found = await freshCandidates(
    deps({
      discover: async () => [{ itemId: 1, url: 'https://a.test/album/1', title: 'A', artist: 'X', location: null }],
      album: async () => null,
    }),
    { tags: ['crust'], subdomains: [], now: new Date('2026-08-03'), maxAgeDays: 7 },
  );
  assert.deepEqual(found, []);
});
```

- [ ] **Step 2: Запустить тесты и убедиться, что падают**

```bash
npm test
```

Ожидается: `Cannot find module './fresh.ts'`.

- [ ] **Step 3: Реализовать `src/pipeline/fresh.ts`**

```ts
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
  /** Субдомены групп и лейблов из подписок. */
  subdomains: string[];
  now: Date;
  maxAgeDays: number;
}

function ageInDays(releasedAt: string, now: Date): number {
  return (now.getTime() - new Date(releasedAt).getTime()) / 86_400_000;
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

  for (const tag of options.tags) {
    for (const item of await deps.discover({ tag, slice: 'new', size: 60 })) {
      if (item.url) seen.set(item.url, { title: item.title, artist: item.artist, itemId: item.itemId });
    }
  }
  for (const subdomain of options.subdomains) {
    for (const release of await deps.bandReleases(subdomain)) {
      if (!seen.has(release.url)) seen.set(release.url, { title: release.title, artist: '', itemId: 0 });
    }
  }

  const candidates: Candidate[] = [];
  for (const [url, base] of seen) {
    const details = await deps.album(url);
    if (!details?.releasedAt) continue;
    if (ageInDays(details.releasedAt, options.now) > options.maxAgeDays) continue;
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
  return candidates;
}
```

- [ ] **Step 4: Запустить тесты**

```bash
npm test
```

Ожидается: все тесты `fresh.test.ts` проходят.

- [ ] **Step 5: Коммит**

```bash
git add src/pipeline/fresh.ts src/pipeline/fresh.test.ts
git commit -m "feat: сбор свежих кандидатов из хабов и подписок"
```

---

## Task 14: Соседи по вкусу и архивные кандидаты

Соседи считаются раз в неделю и сохраняются вместе с их коллекциями — тогда ежедневный запуск не ходит в сеть за чужими коллекциями вообще.

**Files:**
- Create: `src/pipeline/neighbors.ts`, `src/pipeline/archive.ts`
- Test: `src/pipeline/neighbors.test.ts`, `src/pipeline/archive.test.ts`

- [ ] **Step 1: Написать падающие тесты**

```ts
// src/pipeline/neighbors.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FanItem } from '../bandcamp/types.ts';
import { computeNeighbors, type NeighborDeps } from './neighbors.ts';

const item = (id: number): FanItem => ({
  itemId: id,
  bandId: id,
  title: `T${id}`,
  artist: `A${id}`,
  url: `https://x.test/album/${id}`,
  subdomain: 'x',
  alsoCollected: 0,
  addedAt: '2026-01-01',
  source: 'collection',
});

test('сосед с большим пересечением получает больший вес', async () => {
  const deps: NeighborDeps = {
    collectors: async () => [10, 20],
    collectionOf: async (fanId) =>
      fanId === 10 ? [item(1), item(2), item(3)] : [item(1), item(99), item(98)],
  };
  const neighbors = await computeNeighbors(deps, {
    ownerFanId: 1,
    mine: [item(1), item(2), item(3)],
    seedCount: 3,
    candidateLimit: 10,
    neighborLimit: 10,
  });
  assert.equal(neighbors[0]?.fanId, 10);
  assert.ok(neighbors[0]!.weight > neighbors[1]!.weight);
});

test('сам владелец в соседи не попадает', async () => {
  const deps: NeighborDeps = {
    collectors: async () => [7566215],
    collectionOf: async () => [item(1)],
  };
  const neighbors = await computeNeighbors(deps, {
    ownerFanId: 7566215,
    mine: [item(1)],
    seedCount: 1,
    candidateLimit: 5,
    neighborLimit: 5,
  });
  assert.deepEqual(neighbors, []);
});

test('в соседе сохраняются его релизы, чтобы ежедневный запуск не ходил в сеть', async () => {
  const deps: NeighborDeps = {
    collectors: async () => [10],
    collectionOf: async () => [item(1), item(5)],
  };
  const [neighbor] = await computeNeighbors(deps, {
    ownerFanId: 1,
    mine: [item(1)],
    seedCount: 1,
    candidateLimit: 5,
    neighborLimit: 5,
  });
  assert.deepEqual(neighbor?.items.map((i) => i.itemId), [1, 5]);
});

test('соседи с нулевым пересечением отбрасываются', async () => {
  const deps: NeighborDeps = {
    collectors: async () => [10],
    collectionOf: async () => [item(77)],
  };
  const neighbors = await computeNeighbors(deps, {
    ownerFanId: 1,
    mine: [item(1)],
    seedCount: 1,
    candidateLimit: 5,
    neighborLimit: 5,
  });
  assert.deepEqual(neighbors, []);
});
```

```ts
// src/pipeline/archive.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AlbumDetails } from '../bandcamp/types.ts';
import { archiveCandidates } from './archive.ts';

const neighbor = (fanId: number, weight: number, ids: number[]) => ({
  fanId,
  weight,
  items: ids.map((id) => ({
    itemId: id,
    url: `https://x.test/album/${id}`,
    title: `T${id}`,
    artist: `A${id}`,
  })),
});

const album: AlbumDetails = {
  title: 'T',
  artist: 'A',
  label: 'L',
  tags: ['crust'],
  releasedAt: '2015-01-01',
  artUrl: null,
};

test('релизы соседей, которых нет у владельца, становятся кандидатами', async () => {
  const found = await archiveCandidates(
    { album: async () => album },
    {
      neighbors: [neighbor(10, 1, [1, 2])],
      exclude: new Set([1]),
      limit: 10,
    },
  );
  assert.deepEqual(found.map((c) => c.itemId), [2]);
  assert.equal(found[0]?.origin, 'archive');
});

test('вес голосов соседей суммируется и задаёт порядок', async () => {
  const found = await archiveCandidates(
    { album: async () => album },
    {
      neighbors: [neighbor(10, 1, [1, 2]), neighbor(11, 0.5, [2])],
      exclude: new Set(),
      limit: 10,
    },
  );
  assert.equal(found[0]?.itemId, 2);
  assert.equal(found[0]?.neighborWeight, 1.5);
});

test('лимит ограничивает число походов за страницами релизов', async () => {
  let calls = 0;
  const found = await archiveCandidates(
    {
      album: async () => {
        calls += 1;
        return album;
      },
    },
    { neighbors: [neighbor(10, 1, [1, 2, 3, 4, 5])], exclude: new Set(), limit: 2 },
  );
  assert.equal(calls, 2);
  assert.equal(found.length, 2);
});
```

- [ ] **Step 2: Запустить тесты и убедиться, что падают**

```bash
npm test
```

Ожидается: `Cannot find module './neighbors.ts'` и `'./archive.ts'`.

- [ ] **Step 3: Реализовать `src/pipeline/neighbors.ts`**

```ts
import type { FanItem } from '../bandcamp/types.ts';

export interface NeighborItem {
  itemId: number;
  url: string;
  title: string;
  artist: string;
}

export interface Neighbor {
  fanId: number;
  /** Доля пересечения с коллекцией владельца, 0..1. */
  weight: number;
  items: NeighborItem[];
}

export interface NeighborDeps {
  collectors: (albumId: number) => Promise<number[]>;
  collectionOf: (fanId: number) => Promise<FanItem[]>;
}

export interface NeighborOptions {
  ownerFanId: number;
  mine: FanItem[];
  /** Сколько своих релизов взять как затравку графа. */
  seedCount: number;
  /** Сколько самых часто встречающихся фанатов проверять на пересечение. */
  candidateLimit: number;
  neighborLimit: number;
}

export async function computeNeighbors(
  deps: NeighborDeps,
  options: NeighborOptions,
): Promise<Neighbor[]> {
  const mineIds = new Set(options.mine.map((item) => item.itemId));
  const seeds = options.mine.slice(0, options.seedCount);

  // Сколько раз каждый фанат встретился среди покупателей моих релизов.
  const votes = new Map<number, number>();
  for (const seed of seeds) {
    for (const fanId of await deps.collectors(seed.itemId)) {
      if (fanId === options.ownerFanId) continue;
      votes.set(fanId, (votes.get(fanId) ?? 0) + 1);
    }
  }

  const shortlist = [...votes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, options.candidateLimit)
    .map(([fanId]) => fanId);

  const neighbors: Neighbor[] = [];
  for (const fanId of shortlist) {
    const theirs = await deps.collectionOf(fanId);
    if (theirs.length === 0) continue;
    const overlap = theirs.filter((item) => mineIds.has(item.itemId)).length;
    if (overlap === 0) continue;
    neighbors.push({
      fanId,
      weight: Number((overlap / Math.min(theirs.length, mineIds.size)).toFixed(4)),
      items: theirs.map((item) => ({
        itemId: item.itemId,
        url: item.url,
        title: item.title,
        artist: item.artist,
      })),
    });
  }

  return neighbors.sort((a, b) => b.weight - a.weight).slice(0, options.neighborLimit);
}
```

- [ ] **Step 4: Реализовать `src/pipeline/archive.ts`**

```ts
import type { AlbumDetails, Candidate } from '../bandcamp/types.ts';
import type { Neighbor } from './neighbors.ts';

export interface ArchiveDeps {
  album: (url: string) => Promise<AlbumDetails | null>;
}

export interface ArchiveOptions {
  neighbors: Neighbor[];
  /** itemId, которые уже есть у владельца или уже показывались. */
  exclude: Set<number>;
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
  const votes = new Map<number, { weight: number; url: string; title: string; artist: string }>();
  for (const neighbor of options.neighbors) {
    for (const item of neighbor.items) {
      if (options.exclude.has(item.itemId)) continue;
      const current = votes.get(item.itemId);
      if (current) current.weight += neighbor.weight;
      else votes.set(item.itemId, { weight: neighbor.weight, url: item.url, title: item.title, artist: item.artist });
    }
  }

  const ranked = [...votes.entries()]
    .sort((a, b) => b[1].weight - a[1].weight)
    .slice(0, options.limit);

  const candidates: Candidate[] = [];
  for (const [itemId, vote] of ranked) {
    const details = await deps.album(vote.url);
    if (!details) continue;
    candidates.push({
      itemId,
      url: vote.url,
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
```

- [ ] **Step 5: Запустить тесты**

```bash
npm test
```

Ожидается: все тесты `neighbors.test.ts` и `archive.test.ts` проходят.

- [ ] **Step 6: Коммит**

```bash
git add src/pipeline/neighbors.ts src/pipeline/archive.ts src/pipeline/*.test.ts
git commit -m "feat: соседи по вкусу и архивные кандидаты"
```

---

## Task 15: Скрипт построения профиля

**Files:**
- Create: `bin/build-profile.ts`
- Modify: none

- [ ] **Step 1: Написать `bin/build-profile.ts`**

Тестов нет: файл только склеивает уже покрытые тестами куски и ходит в сеть. Проверяется живым запуском на шаге 2.

```ts
import { Http } from '../src/lib/http.ts';
import { writeJson } from '../src/lib/state.ts';
import { fetchAlbum } from '../src/bandcamp/album.ts';
import { fetchFanItems } from '../src/bandcamp/fan.ts';
import { discover } from '../src/bandcamp/discover.ts';
import { BUCKETS, bucketOf } from '../src/profile/buckets.ts';
import { buildProfile, type ProfileInput } from '../src/profile/build.ts';
import { deriveStopTags } from '../src/profile/stop-tags.ts';

const OWNER_FAN_ID = 7566215;
const HUB_SAMPLE = 60;

const http = new Http({ cacheDir: '.cache', minDelayMs: 900 });

console.log('Читаю коллекцию и вишлист…');
const collection = await fetchFanItems(http, OWNER_FAN_ID, 'collection');
const wishlist = await fetchFanItems(http, OWNER_FAN_ID, 'wishlist');
console.log(`Коллекция: ${collection.length}, вишлист: ${wishlist.length}`);

console.log('Читаю страницы релизов (первый раз долго, дальше из кэша)…');
const inputs: ProfileInput[] = [];
const ownedTags = new Set<string>();
for (const item of [...collection, ...wishlist]) {
  const album = await fetchAlbum(http, item.url);
  if (!album) continue;
  for (const tag of album.tags) ownedTags.add(tag);
  inputs.push({
    tags: album.tags,
    label: album.label,
    addedAt: item.addedAt,
    source: item.source,
  });
}

const profile = buildProfile(inputs, { now: new Date(), minReleases: 2 });

console.log('Собираю антипрофиль из тег-хабов…');
for (const bucket of BUCKETS) {
  const hubTagCounts: Record<string, number> = {};
  const topTags = Object.entries(profile.buckets[bucket.id].tags)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([tag]) => tag);
  for (const tag of topTags.length > 0 ? topTags : bucket.seedTags.slice(0, 2)) {
    for (const item of await discover(http, { tag, slice: 'top', size: HUB_SAMPLE })) {
      const album = await fetchAlbum(http, item.url);
      if (!album) continue;
      for (const albumTag of album.tags) {
        hubTagCounts[albumTag] = (hubTagCounts[albumTag] ?? 0) + 1;
      }
    }
  }
  profile.buckets[bucket.id].stopTags = deriveStopTags({ hubTagCounts, ownedTags, minHubCount: 5 });
}

await writeJson('data/profile.json', profile);

for (const bucket of BUCKETS) {
  const data = profile.buckets[bucket.id];
  const top = Object.entries(data.tags)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([tag, weight]) => `${tag} ${weight}`)
    .join(', ');
  console.log(`\n${bucket.channelTitle}: ${data.releaseCount} релизов`);
  console.log(`  теги: ${top}`);
  console.log(`  стоп: ${data.stopTags.slice(0, 12).join(', ')}`);
}
const unbucketed = inputs.filter((item) => bucketOf(item.tags) === null).length;
console.log(`\nВне трёх жанров осталось релизов: ${unbucketed}`);
console.log('Профиль записан в data/profile.json — проверить и поправить руками.');
```

- [ ] **Step 2: Запустить и дождаться (первый прогон — примерно 500 запросов, около 10 минут)**

```bash
npm run build-profile
```

Ожидается: в каждом бакете `releaseCount` больше нуля, у crust и death-metal — десятки; напечатанные топ-теги выглядят как реальные жанры, а не как мусор.

- [ ] **Step 3: Показать результат владельцу и внести правки руками**

Показать `data/profile.json` и вывод скрипта. Владелец правит `tags` и `stopTags` прямо в файле. Дальнейшие запуски профиль не перезаписывают.

- [ ] **Step 4: Коммит**

```bash
git add bin/build-profile.ts data/profile.json
git commit -m "feat: скрипт построения профиля вкуса + первый профиль"
```

---

## Task 16: Клиент Telegram Bot API

**Files:**
- Create: `src/telegram/api.ts`
- Test: `src/telegram/api.test.ts`

- [ ] **Step 1: Написать падающие тесты**

```ts
// src/telegram/api.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Telegram } from './api.ts';

function stub(payload: unknown, status = 200) {
  const calls: { url: string; body: unknown }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(payload), { status });
  }) as unknown as typeof fetch;
  return { telegram: new Telegram('TOKEN', impl), calls };
}

test('токен подставляется в путь, метод — в конец', async () => {
  const { telegram, calls } = stub({ ok: true, result: { message_id: 5 } });
  await telegram.sendMessage({ chat_id: '1', text: 'привет' });
  assert.equal(calls[0]?.url, 'https://api.telegram.org/botTOKEN/sendMessage');
});

test('ok:false превращается в ошибку с описанием', async () => {
  const { telegram } = stub({ ok: false, description: 'chat not found' });
  await assert.rejects(() => telegram.sendMessage({ chat_id: '1', text: 'x' }), /chat not found/);
});

test('getUpdates отдаёт список обновлений', async () => {
  const { telegram, calls } = stub({ ok: true, result: [{ update_id: 7 }] });
  const updates = await telegram.getUpdates(3, 0);
  assert.deepEqual(updates, [{ update_id: 7 }]);
  assert.deepEqual(calls[0]?.body, { offset: 3, timeout: 0, allowed_updates: ['callback_query'] });
});

test('sendPhoto передаёт клавиатуру', async () => {
  const { telegram, calls } = stub({ ok: true, result: { message_id: 9 } });
  await telegram.sendPhoto({
    chat_id: '1',
    photo: 'https://img.test/a.jpg',
    caption: 'подпись',
    reply_markup: { inline_keyboard: [[{ text: 'ok', callback_data: 'x' }]] },
  });
  const body = calls[0]?.body as { reply_markup: { inline_keyboard: unknown[][] } };
  assert.equal(body.reply_markup.inline_keyboard.length, 1);
});
```

- [ ] **Step 2: Запустить тесты и убедиться, что падают**

```bash
npm test
```

Ожидается: `Cannot find module './api.ts'`.

- [ ] **Step 3: Реализовать `src/telegram/api.ts`**

```ts
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
    const body = (await response.json()) as { ok: boolean; result?: T; description?: string };
    if (!body.ok) throw new Error(`telegram ${method}: ${body.description ?? 'неизвестная ошибка'}`);
    return body.result as T;
  }

  sendMessage(payload: {
    chat_id: string | number;
    text: string;
    parse_mode?: 'HTML';
    reply_markup?: InlineKeyboard;
    disable_web_page_preview?: boolean;
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

  /** timeout=0 — короткий опрос: длинный в GitHub Actions только жжёт минуты впустую. */
  getUpdates(offset: number, timeout = 0): Promise<TelegramUpdate[]> {
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
}
```

- [ ] **Step 4: Запустить тесты**

```bash
npm test
```

Ожидается: все тесты `api.test.ts` проходят.

- [ ] **Step 5: Коммит**

```bash
git add src/telegram/api.ts src/telegram/api.test.ts
git commit -m "feat: клиент Telegram Bot API"
```

---

## Task 17: Карточка релиза

**Files:**
- Create: `src/telegram/card.ts`
- Test: `src/telegram/card.test.ts`

- [ ] **Step 1: Написать падающие тесты**

```ts
// src/telegram/card.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candidate } from '../bandcamp/types.ts';
import { buildCard, buildChannelPost, parseCallback } from './card.ts';

const candidate: Candidate = {
  itemId: 42,
  url: 'https://label.bandcamp.com/album/a',
  title: 'Album <Name>',
  artist: 'Band & Co',
  label: 'La Vida Es Un Mus',
  tags: ['crust', 'd-beat'],
  releasedAt: '2026-08-01',
  artUrl: 'https://f4.bcbits.com/img/a1_10.jpg',
  alsoCollected: 120,
  origin: 'fresh',
};

test('в подписке есть артист, альбом, теги и ссылка', () => {
  const card = buildCard(candidate, 'crust', ['crust', 'd-beat']);
  assert.match(card.caption, /Band &amp; Co/);
  assert.match(card.caption, /Album &lt;Name&gt;/);
  assert.match(card.caption, /crust/);
  assert.match(card.caption, /https:\/\/label\.bandcamp\.com\/album\/a/);
});

test('угловые скобки и амперсанды экранируются — иначе Telegram отвергнет HTML', () => {
  const card = buildCard(candidate, 'crust', []);
  assert.ok(!card.caption.includes('<Name>'));
});

test('подпись не превышает лимит Telegram в 1024 символа', () => {
  const long: Candidate = { ...candidate, title: 'Я'.repeat(900), tags: Array(60).fill('тег') };
  assert.ok(buildCard(long, 'crust', []).caption.length <= 1024);
});

test('три кнопки с itemId и бакетом в callback_data', () => {
  const card = buildCard(candidate, 'crust', []);
  const buttons = card.keyboard.inline_keyboard.flat();
  assert.equal(buttons.length, 3);
  for (const button of buttons) {
    assert.ok(button.callback_data.length <= 64, 'callback_data длиннее лимита Telegram');
    assert.deepEqual(parseCallback(button.callback_data)?.itemId, 42);
  }
  assert.deepEqual(
    buttons.map((b) => parseCallback(b.callback_data)?.action),
    ['post', 'skip', 'next'],
  );
});

test('архивный кандидат объясняется соседями, свежий — датой', () => {
  const fresh = buildCard(candidate, 'crust', ['crust']);
  assert.match(fresh.caption, /01\.08\.2026|свеж/i);
  const archive = buildCard({ ...candidate, origin: 'archive', neighborWeight: 0.42 }, 'crust', []);
  assert.match(archive.caption, /сосед/i);
});

test('пост в канал не содержит служебных пометок и кнопок', () => {
  const post = buildChannelPost(candidate, ['crust']);
  assert.ok(!post.includes('callback'));
  assert.match(post, /https:\/\/label\.bandcamp\.com\/album\/a/);
});

test('битый callback_data не роняет разбор', () => {
  assert.equal(parseCallback('мусор'), null);
});
```

- [ ] **Step 2: Запустить тесты и убедиться, что падают**

```bash
npm test
```

Ожидается: `Cannot find module './card.ts'`.

- [ ] **Step 3: Реализовать `src/telegram/card.ts`**

```ts
import type { BucketId, Candidate } from '../bandcamp/types.ts';
import type { InlineKeyboard } from './api.ts';

const CAPTION_LIMIT = 1024;

export type CardAction = 'post' | 'skip' | 'next';

export interface Card {
  photo: string | null;
  caption: string;
  keyboard: InlineKeyboard;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const [year, month, day] = iso.split('-');
  return `${day}.${month}.${year}`;
}

/** callback_data ограничен 64 байтами, поэтому формат предельно короткий. */
export function buildCallback(action: CardAction, bucket: BucketId, itemId: number): string {
  return `${action}|${bucket}|${itemId}`;
}

export function parseCallback(
  data: string,
): { action: CardAction; bucket: BucketId; itemId: number } | null {
  const [action, bucket, itemId] = data.split('|');
  if (!action || !bucket || !itemId) return null;
  if (action !== 'post' && action !== 'skip' && action !== 'next') return null;
  const parsed = Number(itemId);
  if (!Number.isFinite(parsed)) return null;
  return { action, bucket: bucket as BucketId, itemId: parsed };
}

function why(candidate: Candidate, matchedTags: string[]): string {
  if (candidate.origin === 'archive') {
    const percent = Math.round((candidate.neighborWeight ?? 0) * 100);
    return `откопано у соседей по вкусу${percent > 0 ? ` (близость ${percent}%)` : ''}`;
  }
  const date = formatDate(candidate.releasedAt);
  const tags = matchedTags.slice(0, 3).join(', ');
  return `свежее${date ? ` от ${date}` : ''}${tags ? ` · совпало: ${tags}` : ''}`;
}

function body(candidate: Candidate, matchedTags: string[]): string {
  const lines = [
    `<b>${escapeHtml(candidate.artist)}</b> — ${escapeHtml(candidate.title)}`,
    candidate.tags.length > 0 ? escapeHtml(candidate.tags.slice(0, 8).join(' · ')) : '',
    candidate.label ? `лейбл: ${escapeHtml(candidate.label)}` : '',
    why(candidate, matchedTags),
    candidate.url,
  ];
  return lines.filter(Boolean).join('\n');
}

function clamp(text: string): string {
  return text.length <= CAPTION_LIMIT ? text : `${text.slice(0, CAPTION_LIMIT - 1)}…`;
}

export function buildCard(candidate: Candidate, bucket: BucketId, matchedTags: string[]): Card {
  return {
    photo: candidate.artUrl,
    caption: clamp(body(candidate, matchedTags)),
    keyboard: {
      inline_keyboard: [
        [
          { text: '📢 В канал', callback_data: buildCallback('post', bucket, candidate.itemId) },
          { text: '⏭ Скип', callback_data: buildCallback('skip', bucket, candidate.itemId) },
          { text: '🔄 Другой', callback_data: buildCallback('next', bucket, candidate.itemId) },
        ],
      ],
    },
  };
}

export function buildChannelPost(candidate: Candidate, matchedTags: string[]): string {
  return clamp(body(candidate, matchedTags));
}
```

- [ ] **Step 4: Запустить тесты**

```bash
npm test
```

Ожидается: все тесты `card.test.ts` проходят.

- [ ] **Step 5: Коммит**

```bash
git add src/telegram/card.ts src/telegram/card.test.ts
git commit -m "feat: карточка релиза и клавиатура апрува"
```

---

## Task 18: Обработка нажатий

**Files:**
- Create: `src/telegram/approve.ts`
- Test: `src/telegram/approve.test.ts`

- [ ] **Step 1: Написать падающие тесты**

```ts
// src/telegram/approve.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candidate } from '../bandcamp/types.ts';
import { handleUpdates, type ApproveDeps, type ApproveState } from './approve.ts';

const candidate = (itemId: number): Candidate => ({
  itemId,
  url: `https://x.test/album/${itemId}`,
  title: 'T',
  artist: 'A',
  label: null,
  tags: ['crust'],
  releasedAt: '2026-08-01',
  artUrl: null,
  alsoCollected: 0,
  origin: 'fresh',
});

function state(): ApproveState {
  return {
    pending: [
      {
        bucket: 'crust',
        messageId: 100,
        candidate: candidate(1),
        matchedTags: ['crust'],
        alternatives: [candidate(2)],
      },
    ],
    posted: [],
    feedbackTags: {},
    seen: [],
    lastUpdateId: 0,
  };
}

function deps(): ApproveDeps & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    postToChannel: async (bucket, text) => {
      log.push(`post:${bucket}:${text.slice(0, 1)}`);
    },
    replaceCard: async (messageId, candidateItemId) => {
      log.push(`replace:${messageId}:${candidateItemId}`);
    },
    closeCard: async (messageId, note) => {
      log.push(`close:${messageId}:${note}`);
    },
    ack: async () => {
      log.push('ack');
    },
  };
}

const callback = (updateId: number, data: string) => ({
  update_id: updateId,
  callback_query: { id: 'q', data, message: { message_id: 100, chat: { id: 1 } } },
});

test('нажатие «в канал» публикует и записывает в posted', async () => {
  const s = state();
  const d = deps();
  await handleUpdates([callback(5, 'post|crust|1')], s, d);
  assert.ok(d.log.some((entry) => entry.startsWith('post:crust')));
  assert.equal(s.posted.length, 1);
  assert.equal(s.posted[0]?.itemId, 1);
  assert.equal(s.pending.length, 0);
});

test('скип не публикует, а копит штраф по тегам', async () => {
  const s = state();
  const d = deps();
  await handleUpdates([callback(5, 'skip|crust|1')], s, d);
  assert.ok(!d.log.some((entry) => entry.startsWith('post:')));
  assert.equal(s.feedbackTags['crust'], 1);
  assert.equal(s.pending.length, 0);
});

test('«другой» подменяет карточку следующим кандидатом', async () => {
  const s = state();
  const d = deps();
  await handleUpdates([callback(5, 'next|crust|1')], s, d);
  assert.ok(d.log.includes('replace:100:2'));
  assert.equal(s.pending[0]?.candidate.itemId, 2);
  assert.equal(s.pending[0]?.alternatives.length, 0);
});

test('«другой» без запаса кандидатов закрывает карточку', async () => {
  const s = state();
  s.pending[0]!.alternatives = [];
  const d = deps();
  await handleUpdates([callback(5, 'next|crust|1')], s, d);
  assert.ok(d.log.some((entry) => entry.startsWith('close:100')));
  assert.equal(s.pending.length, 0);
});

test('всё показанное попадает в seen', async () => {
  const s = state();
  await handleUpdates([callback(5, 'skip|crust|1')], s, deps());
  assert.ok(s.seen.includes(1));
});

test('lastUpdateId двигается, чтобы обновления не обрабатывались дважды', async () => {
  const s = state();
  await handleUpdates([callback(9, 'skip|crust|1')], s, deps());
  assert.equal(s.lastUpdateId, 9);
});

test('нажатие по неизвестной карточке подтверждается и игнорируется', async () => {
  const s = state();
  const d = deps();
  await handleUpdates([callback(5, 'post|crust|999')], s, d);
  assert.ok(d.log.includes('ack'));
  assert.equal(s.posted.length, 0);
  assert.equal(s.pending.length, 1);
});

test('битый callback не роняет обработку остальных', async () => {
  const s = state();
  const d = deps();
  await handleUpdates([callback(4, 'мусор'), callback(5, 'skip|crust|1')], s, d);
  assert.equal(s.pending.length, 0);
  assert.equal(s.lastUpdateId, 5);
});
```

- [ ] **Step 2: Запустить тесты и убедиться, что падают**

```bash
npm test
```

Ожидается: `Cannot find module './approve.ts'`.

- [ ] **Step 3: Реализовать `src/telegram/approve.ts`**

```ts
import type { BucketId, Candidate } from '../bandcamp/types.ts';
import type { TelegramUpdate } from './api.ts';
import { buildChannelPost, parseCallback } from './card.ts';

export interface PendingCard {
  bucket: BucketId;
  messageId: number;
  candidate: Candidate;
  matchedTags: string[];
  /** Запас на случай нажатия «другой кандидат». */
  alternatives: Candidate[];
}

export interface PostedEntry {
  itemId: number;
  bucket: BucketId;
  url: string;
  title: string;
  artist: string;
  postedAt: string;
}

export interface ApproveState {
  pending: PendingCard[];
  posted: PostedEntry[];
  /** Тег → сколько раз владелец скипнул релиз с этим тегом. */
  feedbackTags: Record<string, number>;
  seen: number[];
  lastUpdateId: number;
}

export interface ApproveDeps {
  postToChannel: (bucket: BucketId, text: string) => Promise<void>;
  replaceCard: (messageId: number, candidateItemId: number) => Promise<void>;
  closeCard: (messageId: number, note: string) => Promise<void>;
  ack: (callbackQueryId: string, text?: string) => Promise<void>;
}

function remember(state: ApproveState, itemId: number): void {
  if (!state.seen.includes(itemId)) state.seen.push(itemId);
}

/**
 * Обрабатывает накопившиеся нажатия. Состояние меняется на месте — вызывающий
 * код сохраняет его в файлы после разбора всей пачки.
 */
export async function handleUpdates(
  updates: TelegramUpdate[],
  state: ApproveState,
  deps: ApproveDeps,
  now: Date = new Date(),
): Promise<void> {
  for (const update of updates) {
    state.lastUpdateId = Math.max(state.lastUpdateId, update.update_id);
    const query = update.callback_query;
    if (!query?.data) continue;

    const parsed = parseCallback(query.data);
    if (!parsed) {
      await deps.ack(query.id);
      continue;
    }

    const index = state.pending.findIndex(
      (card) => card.candidate.itemId === parsed.itemId && card.bucket === parsed.bucket,
    );
    if (index === -1) {
      await deps.ack(query.id, 'карточка уже обработана');
      continue;
    }
    const card = state.pending[index]!;

    if (parsed.action === 'post') {
      await deps.postToChannel(card.bucket, buildChannelPost(card.candidate, card.matchedTags));
      state.posted.push({
        itemId: card.candidate.itemId,
        bucket: card.bucket,
        url: card.candidate.url,
        title: card.candidate.title,
        artist: card.candidate.artist,
        postedAt: now.toISOString().slice(0, 10),
      });
      remember(state, card.candidate.itemId);
      // Карточку закрываем до удаления из pending: обработчик достаёт из неё текст.
      await deps.closeCard(card.messageId, '📢 опубликовано');
      state.pending.splice(index, 1);
      await deps.ack(query.id, 'опубликовано');
      continue;
    }

    if (parsed.action === 'skip') {
      for (const tag of card.candidate.tags) {
        state.feedbackTags[tag] = (state.feedbackTags[tag] ?? 0) + 1;
      }
      remember(state, card.candidate.itemId);
      await deps.closeCard(card.messageId, '⏭ скип');
      state.pending.splice(index, 1);
      await deps.ack(query.id, 'скип');
      continue;
    }

    // next
    remember(state, card.candidate.itemId);
    const replacement = card.alternatives.shift();
    if (!replacement) {
      await deps.closeCard(card.messageId, 'кандидаты кончились');
      state.pending.splice(index, 1);
      await deps.ack(query.id, 'кандидаты кончились');
      continue;
    }
    card.candidate = replacement;
    await deps.replaceCard(card.messageId, replacement.itemId);
    await deps.ack(query.id, 'следующий');
  }
}
```

- [ ] **Step 4: Запустить тесты**

```bash
npm test
```

Ожидается: все тесты `approve.test.ts` проходят.

- [ ] **Step 5: Коммит**

```bash
git add src/telegram/approve.ts src/telegram/approve.test.ts
git commit -m "feat: обработка кнопок апрува"
```

---

## Task 19: Выбор кандидатов дня

Чистая функция отбора: на вход кандидаты и профиль, на выход по два лучших на бакет плюс запас. Сеть и Telegram сюда не заходят.

**Files:**
- Create: `src/pipeline/select.ts`
- Test: `src/pipeline/select.test.ts`

- [ ] **Step 1: Написать падающие тесты**

```ts
// src/pipeline/select.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candidate } from '../bandcamp/types.ts';
import type { BucketProfile } from '../profile/build.ts';
import { selectForBucket } from './select.ts';

const bucket: BucketProfile = {
  tags: { crust: 1, 'd-beat': 0.8 },
  stopTags: ['deathcore'],
  releaseCount: 10,
  weightSum: 12,
};

const candidate = (itemId: number, over: Partial<Candidate> = {}): Candidate => ({
  itemId,
  url: `https://x.test/album/${itemId}`,
  title: `T${itemId}`,
  artist: `A${itemId}`,
  label: null,
  tags: ['crust'],
  releasedAt: '2026-08-01',
  artUrl: null,
  alsoCollected: 0,
  origin: 'fresh',
  ...over,
});

test('на бакет выбирается по одному свежему и одному архивному', () => {
  const picks = selectForBucket({
    bucket,
    fresh: [candidate(1), candidate(2)],
    archive: [candidate(3, { origin: 'archive' })],
    seen: new Set(),
    context: {},
    alternativesCount: 3,
  });
  assert.deepEqual(picks.map((p) => p.candidate.origin), ['fresh', 'archive']);
});

test('показанное ранее не предлагается снова', () => {
  const picks = selectForBucket({
    bucket,
    fresh: [candidate(1)],
    archive: [],
    seen: new Set([1]),
    context: {},
    alternativesCount: 3,
  });
  assert.deepEqual(picks, []);
});

test('отбракованные скорингом не попадают в выбор', () => {
  const picks = selectForBucket({
    bucket,
    fresh: [candidate(1, { tags: ['ambient'] })],
    archive: [],
    seen: new Set(),
    context: {},
    alternativesCount: 3,
  });
  assert.deepEqual(picks, []);
});

test('побеждает кандидат с большим скором, остальные идут в запас', () => {
  const picks = selectForBucket({
    bucket,
    fresh: [candidate(1, { tags: ['crust'] }), candidate(2, { tags: ['crust', 'd-beat'] })],
    archive: [],
    seen: new Set(),
    context: {},
    alternativesCount: 3,
  });
  assert.equal(picks[0]?.candidate.itemId, 2);
  assert.deepEqual(picks[0]?.alternatives.map((c) => c.itemId), [1]);
});

test('в выбор кладутся совпавшие теги для строки «почему»', () => {
  const picks = selectForBucket({
    bucket,
    fresh: [candidate(1, { tags: ['crust', 'd-beat'] })],
    archive: [],
    seen: new Set(),
    context: {},
    alternativesCount: 3,
  });
  assert.deepEqual(picks[0]?.matchedTags, ['crust', 'd-beat']);
});

test('запас ограничен alternativesCount', () => {
  const picks = selectForBucket({
    bucket,
    fresh: [candidate(1), candidate(2), candidate(3), candidate(4), candidate(5)],
    archive: [],
    seen: new Set(),
    context: {},
    alternativesCount: 2,
  });
  assert.equal(picks[0]?.alternatives.length, 2);
});
```

- [ ] **Step 2: Запустить тесты и убедиться, что падают**

```bash
npm test
```

Ожидается: `Cannot find module './select.ts'`.

- [ ] **Step 3: Реализовать `src/pipeline/select.ts`**

```ts
import type { Candidate } from '../bandcamp/types.ts';
import type { BucketProfile } from '../profile/build.ts';
import { score, type ScoreContext } from '../profile/score.ts';

export interface Pick {
  candidate: Candidate;
  matchedTags: string[];
  total: number;
  alternatives: Candidate[];
}

export interface SelectOptions {
  bucket: BucketProfile;
  fresh: Candidate[];
  archive: Candidate[];
  /** itemId, которые уже показывались владельцу. */
  seen: Set<number>;
  context: ScoreContext;
  alternativesCount: number;
}

function rank(
  candidates: Candidate[],
  options: SelectOptions,
): { candidate: Candidate; matchedTags: string[]; total: number }[] {
  return candidates
    .filter((candidate) => !options.seen.has(candidate.itemId))
    .map((candidate) => ({ candidate, result: score(candidate, options.bucket, options.context) }))
    .filter((entry) => !entry.result.rejected)
    .sort((a, b) => b.result.total - a.result.total)
    .map((entry) => ({
      candidate: entry.candidate,
      matchedTags: entry.result.reasons,
      total: entry.result.total,
    }));
}

/** По одному лучшему свежему и архивному релизу на бакет, плюс запас на «другой кандидат». */
export function selectForBucket(options: SelectOptions): Pick[] {
  const picks: Pick[] = [];
  for (const pool of [options.fresh, options.archive]) {
    const ranked = rank(pool, options);
    const best = ranked[0];
    if (!best) continue;
    picks.push({
      candidate: best.candidate,
      matchedTags: best.matchedTags,
      total: best.total,
      alternatives: ranked.slice(1, 1 + options.alternativesCount).map((entry) => entry.candidate),
    });
  }
  return picks;
}
```

- [ ] **Step 4: Запустить тесты**

```bash
npm test
```

Ожидается: все тесты `select.test.ts` проходят.

- [ ] **Step 5: Коммит**

```bash
git add src/pipeline/select.ts src/pipeline/select.test.ts
git commit -m "feat: выбор кандидатов дня по бакетам"
```

---

## Task 20: Скрипт расчёта соседей

**Files:**
- Create: `bin/neighbors.ts`

- [ ] **Step 1: Написать `bin/neighbors.ts`**

```ts
import { Http } from '../src/lib/http.ts';
import { writeJson } from '../src/lib/state.ts';
import { fetchFanItems } from '../src/bandcamp/fan.ts';
import { fetchCollectors } from '../src/bandcamp/collectors.ts';
import { computeNeighbors } from '../src/pipeline/neighbors.ts';

const OWNER_FAN_ID = 7566215;

const http = new Http({ cacheDir: '.cache', minDelayMs: 900 });

console.log('Читаю свою коллекцию…');
const mine = await fetchFanItems(http, OWNER_FAN_ID, 'collection');
console.log(`Релизов: ${mine.length}`);

console.log('Строю граф соседей…');
const neighbors = await computeNeighbors(
  {
    collectors: (albumId) => fetchCollectors(http, albumId, 40),
    collectionOf: (fanId) => fetchFanItems(http, fanId, 'collection'),
  },
  {
    ownerFanId: OWNER_FAN_ID,
    mine,
    seedCount: 40,
    candidateLimit: 80,
    neighborLimit: 40,
  },
);

await writeJson('data/neighbors.json', { generatedAt: new Date().toISOString().slice(0, 10), neighbors });
console.log(`Соседей: ${neighbors.length}`);
for (const neighbor of neighbors.slice(0, 10)) {
  console.log(`  fan ${neighbor.fanId}: близость ${neighbor.weight}, релизов ${neighbor.items.length}`);
}
```

- [ ] **Step 2: Запустить и проверить результат**

```bash
npm run neighbors
```

Ожидается: соседей больше 10, у верхних близость заметно выше нуля. Прогон долгий (около 120 запросов).

- [ ] **Step 3: Коммит**

```bash
git add bin/neighbors.ts data/neighbors.json
git commit -m "feat: расчёт соседей по вкусу"
```

---

## Task 21: Ежедневный запуск

**Files:**
- Create: `src/pipeline/daily.ts`, `bin/daily.ts`

- [ ] **Step 1: Написать `src/pipeline/daily.ts`**

Оркестратор: только склейка уже протестированных частей, собственной логики отбора здесь нет.

```ts
import { Http } from '../lib/http.ts';
import { readJson, writeJson } from '../lib/state.ts';
import { fetchAlbum } from '../bandcamp/album.ts';
import { discover } from '../bandcamp/discover.ts';
import { fetchBandReleases } from '../bandcamp/band.ts';
import { fetchFanItems, fetchFollowedBands } from '../bandcamp/fan.ts';
import type { BucketId } from '../bandcamp/types.ts';
import { BUCKETS } from '../profile/buckets.ts';
import type { Profile } from '../profile/build.ts';
import { freshCandidates } from './fresh.ts';
import { archiveCandidates } from './archive.ts';
import type { Neighbor } from './neighbors.ts';
import { selectForBucket } from './select.ts';
import { Telegram } from '../telegram/api.ts';
import { buildCard } from '../telegram/card.ts';
import { handleUpdates, type ApproveState, type PendingCard } from '../telegram/approve.ts';

const OWNER_FAN_ID = 7566215;
const MAX_AGE_DAYS = 7;
const ARCHIVE_POOL = 30;
const ALTERNATIVES = 3;
const HUB_TAGS_PER_BUCKET = 4;

const PATHS = {
  profile: 'data/profile.json',
  neighbors: 'data/neighbors.json',
  state: 'data/state.json',
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`не задана переменная окружения ${name}`);
  return value;
}

function emptyState(): ApproveState {
  return { pending: [], posted: [], feedbackTags: {}, seen: [], lastUpdateId: 0 };
}

export async function runDaily(options: { listenMinutes: number }): Promise<void> {
  const telegram = new Telegram(requireEnv('TELEGRAM_BOT_TOKEN'));
  const ownerChatId = requireEnv('OWNER_CHAT_ID');
  const channels = new Map<BucketId, string>(
    BUCKETS.map((bucket) => [bucket.id, requireEnv(bucket.channelEnv)]),
  );

  const profile = await readJson<Profile | null>(PATHS.profile, null);
  if (!profile) throw new Error('нет data/profile.json — сначала запустить npm run build-profile');
  const neighborsFile = await readJson<{ neighbors: Neighbor[] }>(PATHS.neighbors, { neighbors: [] });
  const state = await readJson<ApproveState>(PATHS.state, emptyState());

  const deps = {
    postToChannel: async (bucket: BucketId, text: string) => {
      await telegram.sendMessage({
        chat_id: channels.get(bucket)!,
        text,
        parse_mode: 'HTML' as const,
      });
    },
    replaceCard: async (messageId: number, itemId: number) => {
      const card = state.pending.find((entry) => entry.messageId === messageId);
      if (!card) return;
      const built = buildCard(card.candidate, card.bucket, card.matchedTags);
      await telegram.editMessageCaption({
        chat_id: ownerChatId,
        message_id: messageId,
        caption: built.caption,
        parse_mode: 'HTML',
        reply_markup: built.keyboard,
      });
      void itemId;
    },
    closeCard: async (messageId: number, note: string) => {
      const card = state.pending.find((entry) => entry.messageId === messageId);
      await telegram.editMessageCaption({
        chat_id: ownerChatId,
        message_id: messageId,
        caption: card
          ? `${buildCard(card.candidate, card.bucket, card.matchedTags).caption}\n\n${note}`
          : note,
        parse_mode: 'HTML',
      });
    },
    ack: async (callbackQueryId: string, text?: string) => {
      await telegram.answerCallbackQuery({ callback_query_id: callbackQueryId, text });
    },
  };

  // 1. Разобрать нажатия, накопившиеся со вчера.
  const backlog = await telegram.getUpdates(state.lastUpdateId + 1);
  await handleUpdates(backlog, state, deps);
  await writeJson(PATHS.state, state);

  // 2. Собрать сегодняшних кандидатов.
  const http = new Http({ cacheDir: '.cache', minDelayMs: 900 });
  const [collection, wishlist, follows] = [
    await fetchFanItems(http, OWNER_FAN_ID, 'collection'),
    await fetchFanItems(http, OWNER_FAN_ID, 'wishlist'),
    await fetchFollowedBands(http, OWNER_FAN_ID),
  ];
  const owned = new Set([...collection, ...wishlist].map((item) => item.itemId));
  const seen = new Set([...state.seen, ...owned]);
  const now = new Date();

  const cards: PendingCard[] = [];
  for (const bucket of BUCKETS) {
    const bucketProfile = profile.buckets[bucket.id];
    const hubTags = Object.entries(bucketProfile.tags)
      .sort((a, b) => b[1] - a[1])
      .slice(0, HUB_TAGS_PER_BUCKET)
      .map(([tag]) => tag);

    const fresh = await freshCandidates(
      {
        discover: (options) => discover(http, options),
        bandReleases: (subdomain) => fetchBandReleases(http, subdomain),
        album: (url) => fetchAlbum(http, url),
      },
      {
        tags: hubTags.length > 0 ? hubTags : bucket.seedTags.slice(0, 2),
        subdomains: follows.map((band) => band.subdomain).filter(Boolean),
        now,
        maxAgeDays: MAX_AGE_DAYS,
      },
    );

    const archive = await archiveCandidates(
      { album: (url) => fetchAlbum(http, url) },
      { neighbors: neighborsFile.neighbors, exclude: seen, limit: ARCHIVE_POOL },
    );

    const picks = selectForBucket({
      bucket: bucketProfile,
      fresh,
      archive,
      seen,
      context: { labels: profile.labels, tagPenalties: state.feedbackTags },
      alternativesCount: ALTERNATIVES,
    });

    if (picks.length === 0) {
      await telegram.sendMessage({
        chat_id: ownerChatId,
        text: `сегодня по ${bucket.channelTitle} пусто`,
      });
      continue;
    }

    for (const pick of picks) {
      const card = buildCard(pick.candidate, bucket.id, pick.matchedTags);
      const sent = card.photo
        ? await telegram.sendPhoto({
            chat_id: ownerChatId,
            photo: card.photo,
            caption: card.caption,
            parse_mode: 'HTML',
            reply_markup: card.keyboard,
          })
        : await telegram.sendMessage({
            chat_id: ownerChatId,
            text: card.caption,
            parse_mode: 'HTML',
            reply_markup: card.keyboard,
          });
      cards.push({
        bucket: bucket.id,
        messageId: sent.message_id,
        candidate: pick.candidate,
        matchedTags: pick.matchedTags,
        alternatives: pick.alternatives,
      });
      seen.add(pick.candidate.itemId);
    }
  }

  state.pending.push(...cards);
  await writeJson(PATHS.state, state);

  // 3. Подождать нажатий, дальше очередь разберёт завтрашний запуск.
  const until = Date.now() + options.listenMinutes * 60_000;
  while (Date.now() < until && state.pending.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const updates = await telegram.getUpdates(state.lastUpdateId + 1);
    if (updates.length === 0) continue;
    await handleUpdates(updates, state, deps);
    await writeJson(PATHS.state, state);
  }
}
```

- [ ] **Step 2: Написать `bin/daily.ts`**

```ts
import { runDaily } from '../src/pipeline/daily.ts';

const listenMinutes = Number(process.env.LISTEN_MINUTES ?? '120');
await runDaily({ listenMinutes });
```

- [ ] **Step 3: Проверить компиляцию**

```bash
npx tsc --noEmit
```

Ожидается: пусто, код возврата 0.

- [ ] **Step 4: Коммит**

```bash
git add src/pipeline/daily.ts bin/daily.ts
git commit -m "feat: ежедневный запуск с отправкой карточек на апрув"
```

---

## Task 22: Бот, каналы и первый живой прогон

Шаги с BotFather выполняет владелец — у агента нет доступа к его Telegram.

**Files:**
- Create: `README.md`

- [ ] **Step 1: Попросить владельца создать бота и каналы**

Инструкция владельцу:

1. В Telegram открыть `@BotFather` → `/newbot` → имя и username бота → получить токен.
2. Создать три канала: `DEATH METAL DAILY`, `CRUST DAILY`, `HARDCORE PUNK DAILY`.
3. В каждом канале: «Администраторы» → добавить бота → включить право «Публикация сообщений».
4. Написать боту `/start` в личку — без этого бот не сможет прислать карточки.
5. Прислать: токен бота и ссылки/юзернеймы трёх каналов.

- [ ] **Step 2: Узнать chat_id владельца и каналов**

После шага 1 выполнить (токен подставить в переменную окружения, не в историю команд):

```bash
node --import tsx -e "import {Telegram} from './src/telegram/api.ts';const t=new Telegram(process.env.TELEGRAM_BOT_TOKEN);console.log(JSON.stringify(await t.getUpdates(0),null,2))" | head -40
```

Ожидается: JSON с `chat.id` владельца. Для каналов с публичным юзернеймом `chat_id` — это `@username`; для приватных нужно переслать сообщение из канала боту и взять `forward_from_chat.id`.

- [ ] **Step 3: Записать секреты в GitHub**

```bash
gh auth switch --user MishaKolotov
gh secret set TELEGRAM_BOT_TOKEN
gh secret set OWNER_CHAT_ID
gh secret set CRUST_CHANNEL_ID
gh secret set DEATH_METAL_CHANNEL_ID
gh secret set HARDCORE_PUNK_CHANNEL_ID
```

Каждая команда спросит значение в интерактивном вводе — значения в аргументы командной строки не писать.

- [ ] **Step 4: Прогнать локально с коротким окном ожидания**

```bash
LISTEN_MINUTES=3 npm run daily
```

Ожидается: в личку прилетело до 6 карточек, кнопки работают, нажатие «📢 В канал» публикует пост в нужный канал.

- [ ] **Step 5: Написать `README.md`**

````markdown
# bandcamp-daily

Ежедневно подбирает по два релиза (свежий и архивный) в трёх жанрах на основе
коллекции Bandcamp `gigamike666` и после апрува в личке публикует их в каналы
DEATH METAL DAILY, CRUST DAILY, HARDCORE PUNK DAILY.

## Как работает

1. `npm run build-profile` — разово строит `data/profile.json`: веса тегов по
   трём бакетам, веса лейблов, стоп-теги. Файл правится руками.
2. `npm run neighbors` — раз в неделю пересчитывает `data/neighbors.json`:
   фанатов с похожей коллекцией и их релизы.
3. `npm run daily` — ежедневно собирает кандидатов, присылает карточки владельцу
   и по кнопке публикует в канал.

## Состояние

| Файл | Что внутри |
|---|---|
| `data/profile.json` | профиль вкуса, правится руками |
| `data/neighbors.json` | соседи по вкусу и их коллекции |
| `data/state.json` | показанное, опубликованное, штрафы за скипы, offset Telegram |

## Секреты

`TELEGRAM_BOT_TOKEN`, `OWNER_CHAT_ID`, `CRUST_CHANNEL_ID`,
`DEATH_METAL_CHANNEL_ID`, `HARDCORE_PUNK_CHANNEL_ID` — в GitHub Secrets.
Локально — через переменные окружения, не через файлы в репозитории.

## Тесты

```bash
npm test
```

Сеть в тестах не используется: HTTP-клиент подменяется, парсеры работают на
фикстурах из `test/fixtures/`.
````

- [ ] **Step 6: Коммит**

```bash
git add README.md
git commit -m "docs: README проекта"
```

---

## Task 23: GitHub Actions

**Files:**
- Create: `.github/workflows/daily.yml`, `.github/workflows/neighbors-weekly.yml`, `.github/workflows/test.yml`

- [ ] **Step 1: Написать `.github/workflows/test.yml`**

```yaml
name: tests
on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm
      - run: npm ci
      - run: npm test
      - run: npx tsc --noEmit
```

- [ ] **Step 2: Написать `.github/workflows/daily.yml`**

```yaml
name: daily
on:
  schedule:
    # 06:00 UTC = 09:00 МСК
    - cron: '0 6 * * *'
  workflow_dispatch:

permissions:
  contents: write

concurrency:
  group: daily
  cancel-in-progress: false

jobs:
  daily:
    runs-on: ubuntu-latest
    timeout-minutes: 180
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm
      - run: npm ci
      - name: Восстановить кэш страниц релизов
        uses: actions/cache@v4
        with:
          path: .cache
          key: bandcamp-pages-${{ github.run_id }}
          restore-keys: bandcamp-pages-
      - name: Подобрать релизы и дождаться апрува
        env:
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          OWNER_CHAT_ID: ${{ secrets.OWNER_CHAT_ID }}
          CRUST_CHANNEL_ID: ${{ secrets.CRUST_CHANNEL_ID }}
          DEATH_METAL_CHANNEL_ID: ${{ secrets.DEATH_METAL_CHANNEL_ID }}
          HARDCORE_PUNK_CHANNEL_ID: ${{ secrets.HARDCORE_PUNK_CHANNEL_ID }}
          LISTEN_MINUTES: '120'
        run: npm run daily
      - name: Сохранить состояние
        if: always()
        run: |
          git config user.name "bandcamp-daily"
          git config user.email "bot@users.noreply.github.com"
          git add data
          git diff --staged --quiet || git commit -m "chore: состояние за $(date +%F)"
          git push
```

- [ ] **Step 3: Написать `.github/workflows/neighbors-weekly.yml`**

```yaml
name: neighbors
on:
  schedule:
    # понедельник, 03:00 UTC
    - cron: '0 3 * * 1'
  workflow_dispatch:

permissions:
  contents: write

jobs:
  neighbors:
    runs-on: ubuntu-latest
    timeout-minutes: 120
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm
      - run: npm ci
      - run: npm run neighbors
      - name: Сохранить соседей
        run: |
          git config user.name "bandcamp-daily"
          git config user.email "bot@users.noreply.github.com"
          git add data/neighbors.json
          git diff --staged --quiet || git commit -m "chore: пересчёт соседей за $(date +%F)"
          git push
```

- [ ] **Step 4: Создать публичный репозиторий и запушить**

Выполняется только после явного разрешения владельца — это выкладывание кода наружу.

```bash
gh auth switch --user MishaKolotov
gh repo create bandcamp-daily --public --source=. --remote=origin --push
```

- [ ] **Step 5: Проверить, что тесты в CI зелёные**

```bash
gh run list --workflow=tests --limit 1
```

Ожидается: статус `completed success`.

- [ ] **Step 6: Прогнать daily вручную и убедиться, что карточки пришли**

```bash
gh workflow run daily
```

Ожидается: через пару минут в личке появляются карточки; после нажатия «📢 В канал» пост уходит в канал, а `data/state.json` обновляется коммитом бота.

- [ ] **Step 7: Коммит**

```bash
git add .github/workflows
git commit -m "ci: расписание ежедневного запуска и недельного пересчёта соседей"
git push
```

---

## Task 24: Неделя наблюдения и подстройка

- [ ] **Step 1: Каждый день первую неделю смотреть, что предлагает бот**

Владелец скипает мимо-кассы. Скипы копятся в `data/state.json` → `feedbackTags`.

- [ ] **Step 2: Через неделю посмотреть накопившиеся штрафы**

```bash
node --import tsx -e "const s=JSON.parse(await (await import('node:fs/promises')).readFile('data/state.json','utf8'));console.log(Object.entries(s.feedbackTags).sort((a,b)=>b[1]-a[1]).slice(0,20))"
```

- [ ] **Step 3: Перенести устойчивые штрафы в стоп-теги профиля**

Теги со счётчиком 3 и выше, которые владелец подтверждает как «не моё», дописать руками в `stopTags` соответствующего бакета в `data/profile.json`.

- [ ] **Step 4: Коммит**

```bash
git add data/profile.json
git commit -m "chore: стоп-теги по итогам первой недели"
git push
```

---

## Что осталось за рамками

Автопубликация без апрува, веб-интерфейс, база данных, другие жанры и каналы, автоматическое переобучение профиля. Всё это добавляется отдельными задачами, если понадобится.
