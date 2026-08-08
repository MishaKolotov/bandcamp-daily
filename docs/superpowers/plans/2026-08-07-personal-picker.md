# Персональный подборщик — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить ежедневный апрув четырёх карточек в четыре Telegram-канала на персонального подборщика, который дважды в день присылает владельцу в личку один лучший альбом — или молчит, если ничего стоящего нет.

**Architecture:** Каналы выпиливаются целиком (публикация, кнопка, конфиг, состояние). Четыре бакета остаются как внутренняя деталь скоринга: кандидаты каждого бакета считаются против своего профиля, после чего все четыре списка сливаются в один рейтинг по сырому `total` (шкала общая — опорный тег везде зафиксирован на 0.5, остальные нормированы к 1). Побеждает максимум, при условии что он выше порога и не из того же бакета, что победитель прошлого захода.

**Tech Stack:** Node 20, TypeScript через `tsx` (без шага сборки), `node:test`, GitHub Actions.

Спека: `docs/superpowers/specs/2026-08-07-personal-picker-design.md`

---

## Структура файлов

| Файл | Что с ним | Ответственность после правки |
|---|---|---|
| `src/pipeline/pick.ts` | **создать** | Единый рейтинг кандидатов по всем бакетам, порог, запрет на повтор жанра |
| `src/pipeline/pick.test.ts` | **создать** | Тесты рейтинга |
| `src/pipeline/select.ts` | **удалить** | — (заменён на `pick.ts`) |
| `src/pipeline/select.test.ts` | **удалить** | — |
| `src/telegram/approve.ts` | править | Обработка нажатий: только `skip`/`next`, без публикации |
| `src/telegram/card.ts` | править | Карточка владельца с двумя кнопками; `buildChannelPost` удаляется |
| `src/profile/buckets.ts` | править | `channelEnv` удаляется, `channelTitle` → `title` с жанровым именем |
| `src/pipeline/daily.ts` | править | Прогон: собрать → выбрать один → отправить или промолчать |
| `bin/daily.ts` | править | Реальные зависимости без канальных |
| `.github/workflows/daily.yml` | править | Два расписания, без канальных секретов, таймаут 45 |
| `README.md` | править | Описание новой схемы |

Порядок задач — снизу вверх по зависимостям: сначала выпиливание каналов (оно самодостаточно и уменьшает поверхность), потом новый отбор, потом проводка в прогон, потом расписание и доки.

---

### Task 1: Выпилить публикацию в канал из обработки нажатий

**Files:**
- Modify: `src/telegram/card.ts`
- Modify: `src/telegram/approve.ts`
- Test: `src/telegram/card.test.ts`, `src/telegram/approve.test.ts`

- [ ] **Step 1: Переписать тест клавиатуры под две кнопки**

В `src/telegram/card.test.ts` найти тест, проверяющий три кнопки карточки, и заменить его на:

```ts
test('карточка владельца несёт ровно две кнопки — скип и другой', () => {
  const card = buildCard(candidate(1), 'crust', ['crust']);
  const row = card.keyboard.inline_keyboard[0]!;
  assert.equal(row.length, 2);
  assert.deepEqual(
    row.map((button) => parseCallback(button.callback_data)?.action),
    ['skip', 'next'],
  );
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npx tsx --test src/telegram/card.test.ts`
Expected: FAIL — кнопок три, ожидалось две.

- [ ] **Step 3: Убрать кнопку и действие `post` из card.ts**

В `src/telegram/card.ts`:

```ts
export type CardAction = 'skip' | 'next';
```

В `parseCallback` убрать `post` из проверки:

```ts
  if (action !== 'skip' && action !== 'next') return null;
```

В `MAX_ACTION_LENGTH` убрать `'post'`:

```ts
const MAX_ACTION_LENGTH = Math.max('skip'.length, 'next'.length);
```

В `buildCard` оставить два элемента клавиатуры:

```ts
    keyboard: {
      inline_keyboard: [
        [
          { text: '👎 Не моё', callback_data: buildCallback('skip', bucket, candidate.itemId) },
          { text: '🔄 Другой', callback_data: buildCallback('next', bucket, candidate.itemId) },
        ],
      ],
    },
```

Удалить целиком функцию `buildChannelPost` и её JSDoc (последние ~30 строк файла).

- [ ] **Step 4: Убрать публикацию из approve.ts**

В `src/telegram/approve.ts` удалить:
- интерфейс `PostedEntry` целиком;
- поле `posted: PostedEntry[];` из `ApproveState`;
- поле `notices?: number[];` из `ApproveState` вместе с его JSDoc (писателя не останется — см. Task 4);
- поле `postToChannel` из `ApproveDeps` вместе с JSDoc;
- функцию `handlePost` целиком;
- импорт `buildChannelPost` из `./card.ts`;
- импорт `TelegramApiError` из `./api.ts`.

В `handleUpdates` заменить ветвление на:

```ts
    try {
      if (parsed.action === 'skip') {
        await handleSkip(state, deps, card, index, query.id);
      } else {
        await handleNext(state, deps, card, index, query.id);
      }
    } catch (error) {
```

Убрать теперь неиспользуемые параметры `bucketTagsByBucket` и `now` из сигнатуры `handleUpdates` и её JSDoc — они существовали только ради `handlePost`:

```ts
export async function handleUpdates(
  updates: TelegramUpdate[],
  state: ApproveState,
  deps: ApproveDeps,
): Promise<void> {
```

- [ ] **Step 5: Почистить тесты approve**

В `src/telegram/approve.test.ts`:
- удалить фикстуру `bucketTags` и её JSDoc, а также константу `failingPostDeps`;
- удалить все тесты, где `data` начинается с `post|` (публикация, идемпотентность, ошибки канала) — их поведения больше нет;
- в фикстуре `state()` убрать `posted: []` и `notices`;
- в фикстуре `deps()` убрать `postToChannel`;
- во всех оставшихся вызовах убрать третий и четвёртый аргументы: `await handleUpdates([callback(5, 'skip|crust|1')], s, d);`

- [ ] **Step 6: Прогнать типы и тесты**

Run: `npx tsc --noEmit && npm test`
Expected: `tsc` молчит; часть тестов в `daily.test.ts` падает на отсутствующих полях — это ожидаемо, чинится в Task 2 и Task 4. Тесты `card.test.ts` и `approve.test.ts` зелёные.

- [ ] **Step 7: Коммит**

```bash
git add src/telegram/card.ts src/telegram/approve.ts src/telegram/card.test.ts src/telegram/approve.test.ts
git commit -m "feat: убрать публикацию в канал из карточки и обработки нажатий"
```

---

### Task 2: Выпилить каналы из конфигурации и определения бакетов

**Files:**
- Modify: `src/profile/buckets.ts`
- Modify: `src/telegram/card.ts`
- Modify: `src/pipeline/daily.ts:188-213` (`DailyConfig`, `loadConfig`)
- Modify: `bin/daily.ts`
- Test: `src/profile/buckets.test.ts`, `src/pipeline/daily.test.ts`

- [ ] **Step 1: Написать падающий тест на конфиг без канальных переменных**

В `src/pipeline/daily.test.ts` добавить:

```ts
test('loadConfig требует только токен и чат владельца', () => {
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: 't', OWNER_CHAT_ID: '42' });
  assert.equal(config.botToken, 't');
  assert.equal(config.ownerChatId, '42');
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npx tsx --test src/pipeline/daily.test.ts`
Expected: FAIL — `не заданы переменные окружения: CRUST_CHANNEL_ID, ...`

- [ ] **Step 3: Переписать BucketDef без канальных полей**

В `src/profile/buckets.ts` заменить интерфейс:

```ts
export interface BucketDef {
  id: BucketId;
  /** Человекочитаемое имя жанра — уходит в текст карточки владельца. */
  title: string;
  /**
   * Опорные теги: по ним релиз из коллекции относится к бакету.
   * Остальные веса тегов вычисляются из данных, эти заданы вручную.
   */
  seedTags: readonly string[];
}
```

В каждом из четырёх элементов `BUCKETS` удалить строку `channelEnv: ...` и заменить `channelTitle` на `title` с жанровым именем вместо имени канала:

```ts
    title: 'краст',            // было channelTitle: 'CRUST DAILY'
    title: 'дэт-метал',        // было channelTitle: 'DEATH METAL DAILY'
    title: 'хардкор-панк',     // было channelTitle: 'HARDCORE PUNK DAILY'
    title: 'блэк-метал',       // было channelTitle: 'BLACK METAL DAILY'
```

- [ ] **Step 4: Поправить card.ts под переименование**

В `src/telegram/card.ts` переименовать функцию и поле:

```ts
function bucketTitleOf(bucket: BucketId): string | undefined {
  return BUCKETS.find((b) => b.id === bucket)?.title;
}
```

В `BodyOptions` переименовать поле `channelTitle` в `bucketTitle` и заменить его JSDoc на:

```ts
  /**
   * Человекочитаемое имя жанра. Владелец получает один альбом за заход из
   * любого из четырёх бакетов, и без подписи не видно, из какого именно —
   * а это ровно тот контекст, по которому он решает, слушать сейчас или
   * позже.
   */
  bucketTitle?: string;
```

Внутри `body()` заменить все три обращения `options.channelTitle` на `options.bucketTitle` (строки с `channelLine` и `channelReserve`). В `buildCard` заменить `channelTitle: channelTitleOf(bucket)` на `bucketTitle: bucketTitleOf(bucket)`.

- [ ] **Step 5: Убрать канальные переменные из конфига**

В `src/pipeline/daily.ts` заменить `DailyConfig` и `loadConfig`:

```ts
export interface DailyConfig {
  botToken: string;
  ownerChatId: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DailyConfig {
  const missing: string[] = [];
  const read = (name: string): string => {
    const value = env[name];
    if (!value) missing.push(name);
    return value ?? '';
  };

  const botToken = read('TELEGRAM_BOT_TOKEN');
  const ownerChatId = read('OWNER_CHAT_ID');

  if (missing.length > 0) {
    throw new Error(`не заданы переменные окружения: ${missing.join(', ')}`);
  }
  return { botToken, ownerChatId };
}
```

Убрать из JSDoc над `DailyConfig` абзац про «пять переменных окружения» и про `BUCKETS`/`channelEnv`, заменив первое предложение на: «Две переменные окружения, без которых прогон не имеет смысла: токен бота и чат владельца.»

В `bin/daily.ts` убрать из объекта `deps.telegram` поле `postToChannel` целиком.

- [ ] **Step 6: Прогнать типы и тесты**

Run: `npx tsc --noEmit && npx tsx --test src/profile/buckets.test.ts src/telegram/card.test.ts`
Expected: `tsc` укажет только на `daily.test.ts` и `daily.ts` (чинится в Task 4); указанные тесты зелёные. Если в `buckets.test.ts` есть проверки `channelEnv`/`channelTitle` — переписать их на `title`.

- [ ] **Step 7: Коммит**

```bash
git add src/profile/buckets.ts src/telegram/card.ts src/pipeline/daily.ts bin/daily.ts src/profile/buckets.test.ts src/pipeline/daily.test.ts
git commit -m "feat: убрать каналы из определения бакетов и конфигурации"
```

---

### Task 3: `pickBest` — единый рейтинг по всем бакетам

**Files:**
- Create: `src/pipeline/pick.ts`
- Test: `src/pipeline/pick.test.ts`

- [ ] **Step 1: Написать падающие тесты**

Создать `src/pipeline/pick.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BucketId, Candidate } from '../bandcamp/types.ts';
import type { BucketProfile } from '../profile/build.ts';
import { pickBest, type BucketInput } from './pick.ts';

const candidate = (url: string, tags: string[], over: Partial<Candidate> = {}): Candidate => ({
  itemId: 1,
  url,
  title: 'T',
  artist: 'A',
  label: null,
  tags,
  releasedAt: '2026-08-01',
  artUrl: null,
  alsoCollected: 0,
  origin: 'fresh',
  ...over,
});

/** Профиль, где перечисленные теги весят по 1 — чтобы total был предсказуем. */
const profileOf = (tags: Record<string, number>): BucketProfile => ({
  tags,
  stopTags: [],
  releaseCount: 10,
  weightSum: 1,
});

const bucketInput = (id: BucketId, tags: string[], seedTags: string[], weights: Record<string, number>): BucketInput => ({
  id,
  profile: profileOf(weights),
  seedTags,
  fresh: [candidate(`https://x.test/${id}`, tags)],
  archive: [],
});

const base = {
  hardRejectTags: [] as readonly string[],
  seen: new Set<string>(),
  context: {},
  alternativesCount: 3,
  minTotal: 0,
};

test('побеждает кандидат с максимальным total, независимо от бакета', () => {
  const best = pickBest({
    ...base,
    buckets: [
      bucketInput('crust', ['crust'], ['crust'], { crust: 0.5 }),
      bucketInput('black-metal', ['black metal', 'raw black metal'], ['black metal'], {
        'black metal': 0.5,
        'raw black metal': 1,
      }),
    ],
  });
  assert.equal(best?.bucket, 'black-metal');
});

test('ниже порога — не возвращает ничего', () => {
  const best = pickBest({
    ...base,
    minTotal: 99,
    buckets: [bucketInput('crust', ['crust'], ['crust'], { crust: 0.5 })],
  });
  assert.equal(best, null);
});

test('бакет прошлого пика исключается целиком', () => {
  const best = pickBest({
    ...base,
    excludeBucket: 'black-metal',
    buckets: [
      bucketInput('crust', ['crust'], ['crust'], { crust: 0.5 }),
      bucketInput('black-metal', ['black metal', 'raw black metal'], ['black metal'], {
        'black metal': 0.5,
        'raw black metal': 1,
      }),
    ],
  });
  assert.equal(best?.bucket, 'crust');
});

test('запас «другой» берётся только из бакета победителя', () => {
  const best = pickBest({
    ...base,
    buckets: [
      {
        id: 'crust',
        profile: profileOf({ crust: 0.5, dbeat: 1 }),
        seedTags: ['crust'],
        fresh: [
          candidate('https://x.test/a', ['crust', 'd-beat']),
          candidate('https://x.test/b', ['crust']),
        ],
        archive: [],
      },
      bucketInput('death-metal', ['death metal'], ['death metal'], { 'death metal': 0.5 }),
    ],
  });
  assert.equal(best?.candidate.url, 'https://x.test/a');
  assert.deepEqual(
    best?.alternatives.map((c) => c.url),
    ['https://x.test/b'],
  );
});

test('уже показанное не рассматривается', () => {
  const best = pickBest({
    ...base,
    seen: new Set(['https://x.test/crust']),
    buckets: [bucketInput('crust', ['crust'], ['crust'], { crust: 0.5 })],
  });
  assert.equal(best, null);
});

test('один и тот же релиз в двух бакетах не задваивается — остаётся сильнейшее совпадение', () => {
  const shared = ['crust', 'd-beat'];
  const best = pickBest({
    ...base,
    buckets: [
      { id: 'crust', profile: profileOf({ crust: 0.5, dbeat: 1 }), seedTags: ['crust'], fresh: [candidate('https://x.test/same', shared)], archive: [] },
      { id: 'hardcore-punk', profile: profileOf({ crust: 0.2, punk: 0.5 }), seedTags: ['crust'], fresh: [candidate('https://x.test/same', shared)], archive: [] },
    ],
  });
  assert.equal(best?.bucket, 'crust');
  assert.deepEqual(best?.alternatives, []);
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx tsx --test src/pipeline/pick.test.ts`
Expected: FAIL — модуль `./pick.ts` не найден.

- [ ] **Step 3: Написать `pick.ts`**

Создать `src/pipeline/pick.ts`:

```ts
import type { BucketId, Candidate } from '../bandcamp/types.ts';
import type { BucketProfile } from '../profile/build.ts';
import { score, type ScoreContext } from '../profile/score.ts';

/** Один бакет с уже собранными пулами — свежак и архив вместе образуют его список кандидатов. */
export interface BucketInput {
  id: BucketId;
  profile: BucketProfile;
  seedTags: readonly string[];
  fresh: Candidate[];
  archive: Candidate[];
}

export interface PickOptions {
  buckets: BucketInput[];
  hardRejectTags: readonly string[];
  /** URL, уже показанные владельцу — ключ URL, а не itemId (см. `ApproveState.seen`). */
  seen: ReadonlySet<string>;
  context: ScoreContext;
  alternativesCount: number;
  /** Ниже этого total пик не отдаётся вовсе — прогон промолчит. */
  minTotal: number;
  /** Бакет прошлого пика: исключается целиком, чтобы жанр не повторялся два захода подряд. */
  excludeBucket?: BucketId;
}

export interface BestPick {
  bucket: BucketId;
  candidate: Candidate;
  matchedTags: string[];
  total: number;
  alternatives: Candidate[];
}

interface RankedEntry {
  bucket: BucketId;
  candidate: Candidate;
  matchedTags: string[];
  total: number;
}

/**
 * Схлопывает кандидатов по URL, оставляя сильнейшее совпадение.
 *
 * Один и тот же релиз приходит дважды по двум разным причинам, и обе здесь
 * лечатся одинаково: он мог прийти из разных источников внутри одного бакета
 * (тег-хаб Discover даёт настоящий item_id, дискография подписки — хеш URL),
 * и он мог законно попасть сразу в два бакета — кроссовер вроде crust/hardcore
 * несёт опорные теги обоих. Во втором случае бакет-победитель определяется не
 * порядком в массиве, а тем, против чьего профиля релиз набрал больше: это и
 * есть ответ на вопрос «чей он больше».
 *
 * При точном равенстве total побеждает первый по алфавиту id бакета — сам по
 * себе он ничего не значит, но он стабилен, а исход обязан быть
 * детерминированным независимо от порядка обхода.
 */
function dedupeByUrl(entries: RankedEntry[]): RankedEntry[] {
  const byUrl = new Map<string, RankedEntry>();
  for (const entry of entries) {
    const existing = byUrl.get(entry.candidate.url);
    if (
      !existing ||
      entry.total > existing.total ||
      (entry.total === existing.total && entry.bucket < existing.bucket)
    ) {
      byUrl.set(entry.candidate.url, entry);
    }
  }
  return [...byUrl.values()];
}

/**
 * Один лучший релиз на весь заход — или `null`, если ничего не дотянуло до
 * порога.
 *
 * Рейтинг сквозной по всем бакетам, по СЫРОМУ total, без нормировки на бакет.
 * Шкала у бакетов общая по построению `buildProfile`: опорный тег везде
 * зафиксирован ровно на 0.5, остальные нормированы к максимуму 1 — так что
 * складывать кандидатов разных жанров в один список законно.
 *
 * Перекос в сторону плотнее населённого в коллекции жанра при этом остаётся, и
 * лечится он не нормировкой, а `excludeBucket` — запретом повторить жанр
 * прошлого захода (см. спеку, раздел про ранжирование).
 *
 * Сеть и файлы функция не трогает: пулы, показанное и порог приходят готовыми.
 */
export function pickBest(options: PickOptions): BestPick | null {
  const ranked: RankedEntry[] = [];
  for (const bucket of options.buckets) {
    if (options.excludeBucket !== undefined && bucket.id === options.excludeBucket) continue;
    for (const candidate of [...bucket.fresh, ...bucket.archive]) {
      if (options.seen.has(candidate.url)) continue;
      const result = score(
        candidate,
        bucket.profile,
        bucket.seedTags,
        options.hardRejectTags,
        options.context,
      );
      if (result.rejected) continue;
      ranked.push({
        bucket: bucket.id,
        candidate,
        matchedTags: result.reasons,
        total: result.total,
      });
    }
  }

  const unique = dedupeByUrl(ranked).sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return a.candidate.url < b.candidate.url ? -1 : a.candidate.url > b.candidate.url ? 1 : 0;
  });

  const top = unique[0];
  if (!top || top.total < options.minTotal) return null;

  // Запас на «другой» — только из бакета победителя: карточка уже отправлена с
  // его bucket в callback_data, и подмена кандидата на релиз другого жанра
  // разошлась бы с подписью карточки и с ключом, по которому `handleUpdates`
  // ищет карточку в pending.
  const alternatives = unique
    .slice(1)
    .filter((entry) => entry.bucket === top.bucket)
    .slice(0, options.alternativesCount)
    .map((entry) => entry.candidate);

  return {
    bucket: top.bucket,
    candidate: top.candidate,
    matchedTags: top.matchedTags,
    total: top.total,
    alternatives,
  };
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `npx tsx --test src/pipeline/pick.test.ts`
Expected: PASS, 6 тестов.

- [ ] **Step 5: Коммит**

```bash
git add src/pipeline/pick.ts src/pipeline/pick.test.ts
git commit -m "feat: pickBest — сквозной рейтинг кандидатов по всем бакетам"
```

---

### Task 4: Проводка в дневной прогон

**Files:**
- Modify: `src/pipeline/daily.ts`
- Modify: `bin/daily.ts`
- Delete: `src/pipeline/select.ts`, `src/pipeline/select.test.ts`
- Test: `src/pipeline/daily.test.ts`

- [ ] **Step 1: Написать падающие тесты прогона**

В `src/pipeline/daily.test.ts` заменить тест `runDaily: обходит бакеты generично по BUCKETS` и тест про пустой бакет с `notifyOwner` на:

```ts
test('runDaily: отправляет ровно одну карточку за заход', async () => {
  const profile = fakeProfile();
  const state = emptyState();
  const telegram = baseTelegram();

  const deps: DailyDeps = {
    fresh: {
      discover: async (opts) => [
        { itemId: 1, url: `https://x.test/album/${opts.tag}`, title: opts.tag, artist: 'A', location: null },
      ],
      bandReleases: async () => [],
      album: async (url) => album({ tags: [url.split('/').pop()!] }),
    },
    archive: { album: async () => null },
    fetchOwnedUrls: async () => [],
    fetchFollowSubdomains: async () => [],
    telegram,
    persistState: async () => {},
    now: () => new Date('2026-08-03'),
  };

  await runDaily(profile, [], state, deps, baseOptions);

  assert.equal(telegram.sentCards.length, 1);
  assert.equal(state.pending.length, 1);
  assert.ok(state.lastBucket, 'бакет пика запоминается для запрета на повтор');
});

test('runDaily: ниже порога не отправляет ничего и не трогает lastBucket', async () => {
  const profile = fakeProfile();
  const state = emptyState();
  state.lastBucket = 'crust';
  const telegram = baseTelegram();

  const deps: DailyDeps = {
    fresh: {
      discover: async (opts) => [
        { itemId: 1, url: `https://x.test/album/${opts.tag}`, title: opts.tag, artist: 'A', location: null },
      ],
      bandReleases: async () => [],
      album: async (url) => album({ tags: [url.split('/').pop()!] }),
    },
    archive: { album: async () => null },
    fetchOwnedUrls: async () => [],
    fetchFollowSubdomains: async () => [],
    telegram,
    persistState: async () => {},
    now: () => new Date('2026-08-03'),
  };

  await runDaily(profile, [], state, deps, { ...baseOptions, minTotal: 99 });

  assert.equal(telegram.sentCards.length, 0);
  assert.equal(state.pending.length, 0);
  assert.equal(state.lastBucket, 'crust', 'молчаливый заход не сбрасывает запрет');
});
```

В фикстуре `emptyState()` (в том же файле) убрать `posted` и `notices`. В `FakeTelegramDeps` и `baseTelegram()` убрать `postToChannel` и `notifyOwner`. В `baseOptions` добавить `minTotal: 0`.

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx tsc --noEmit`
Expected: FAIL — `minTotal` нет в `DailyOptions`, `lastBucket` нет в `ApproveState`.

- [ ] **Step 3: Добавить `lastBucket` в состояние**

В `src/telegram/approve.ts` в `ApproveState` добавить:

```ts
  /**
   * Бакет прошлого отправленного пика. `pickBest` исключает его из
   * рассмотрения, чтобы один и тот же жанр не выигрывал два захода подряд
   * (сырой скор без нормировки systematically тянет в сторону плотнее
   * населённого жанра — см. спеку).
   *
   * Поле необязательное: до первого пика его нет, и это корректно означает
   * «запрета нет».
   */
  lastBucket?: BucketId;
```

Добавить импорт типа, если его нет: `import type { BucketId } from '../bandcamp/types.ts';`

- [ ] **Step 4: Переписать сбор и отправку в `runDaily`**

В `src/pipeline/daily.ts`:

Заменить импорт `./select.ts` на `./pick.ts`:

```ts
import { pickBest, type BucketInput } from './pick.ts';
```

Убрать из `DailyTelegramDeps` поле `notifyOwner` вместе с JSDoc. Убрать функцию `bucketEmptyMessage` целиком и её тесты, если они есть.

В `DailyOptions` добавить:

```ts
  /** Ниже этого total прогон молчит и не шлёт ничего вовсе. */
  minTotal: number;
```

В `sweepStaleMessages` убрать половину про уведомления — остаются только карточки:

```ts
async function sweepStaleMessages(state: ApproveState, deps: DailyDeps): Promise<void> {
  const stale = state.pending.map((card) => ({ messageId: card.messageId, url: card.candidate.url }));
  if (stale.length === 0) return;

  for (const { messageId, url } of stale) {
    rememberSeen(state, url);
    try {
      await deps.telegram.deleteCard(messageId);
    } catch (error) {
      console.error(`daily: не удалось снести сообщение ${messageId} из лички`, error);
    }
  }

  state.pending = [];
  await deps.persistState(state);
}
```

Удалить строку `const shown = new Set(excluded);` вместе с её комментарием — она страховала от показа одного релиза в двух карточках одного дня, а карточка теперь одна.

Заменить весь цикл `for (const bucket of BUCKETS) { ... }` (сбор + отправка, шаг 2 прогона) на сбор входов и один пик:

```ts
  const bucketInputs: BucketInput[] = [];
  for (const bucket of BUCKETS) {
    try {
      const bucketProfile = profile.buckets[bucket.id];
      const hubTags = hubTagsForBucket(bucketProfile, bucket.seedTags, options.hubTagsPerBucket);
      const hubFresh = await freshCandidates(deps.fresh, {
        tags: hubTags,
        subdomains: [],
        now,
        maxAgeDays: options.maxAgeDays,
        maxFutureDays: options.maxFutureDays,
      });
      bucketInputs.push({
        id: bucket.id,
        profile: bucketProfile,
        seedTags: bucket.seedTags,
        fresh: [...hubFresh, ...followsFresh],
        archive: archivePool,
      });
    } catch (error) {
      // Один упавший бакет (сеть, discover) не должен утащить с собой
      // остальные три — они читают из независимо собранных пулов.
      console.error(`daily: сбор кандидатов бакета ${bucket.id} упал, бакет пропущен на сегодня`, error);
    }
  }

  const best = pickBest({
    buckets: bucketInputs,
    hardRejectTags: profile.hardRejectTags ?? [],
    seen: excluded,
    context: { labels: profile.labels, tagPenalties: state.feedbackTags },
    alternativesCount: options.alternativesCount,
    minTotal: options.minTotal,
    excludeBucket: state.lastBucket,
  });

  // Ничего не дотянуло до порога — молчим. Никакого «сегодня пусто» в личку:
  // это ровно тот шум, ради устранения которого вся схема и переделана.
  if (!best) {
    console.log('daily: ничего выше порога, заход молчит');
    return;
  }

  const card = buildCard(best.candidate, best.bucket, best.matchedTags);
  const sent = await deps.telegram.sendCard(card);
  state.pending.push({
    bucket: best.bucket,
    messageId: sent.messageId,
    hasPhoto: card.photo !== null,
    candidate: best.candidate,
    matchedTags: best.matchedTags,
    alternatives: best.alternatives,
  });
  state.lastBucket = best.bucket;
  await deps.persistState(state);
```

В цикле ожидания на шаге 3 убрать теперь несуществующие аргументы `handleUpdates`:

```ts
    await handleUpdates(updates, state, approveDeps);
```

То же самое — в дренаже backlog на шаге 1. Убрать блок вычисления `bucketTags` (`const bucketTags = {} as Record<...>` и цикл под ним) вместе с JSDoc — он существовал только ради хэштегов поста в канал.

- [ ] **Step 5: Поправить `bin/daily.ts`**

Убрать из `deps.telegram` поле `notifyOwner`. В `emptyState()` убрать `posted` и `notices`:

```ts
function emptyState(): ApproveState {
  return { pending: [], feedbackTags: {}, seen: [], lastUpdateId: 0 };
}
```

В `options` добавить порог:

```ts
  minTotal: Number(process.env.MIN_TOTAL ?? '1.5'),
```

и снизить окно ожидания:

```ts
  listenMinutes: Number(process.env.LISTEN_MINUTES ?? '20'),
```

- [ ] **Step 6: Удалить осиротевший селектор**

```bash
git rm src/pipeline/select.ts src/pipeline/select.test.ts
```

- [ ] **Step 7: Прогнать типы и все тесты**

Run: `npx tsc --noEmit && npm test`
Expected: `tsc` молчит, все тесты зелёные. Если `daily.test.ts` ссылается на `selectForBucket` или `BucketSelection` — убрать эти импорты и тесты, их поведение переехало в `pick.test.ts`.

- [ ] **Step 8: Коммит**

```bash
git add -A src bin
git commit -m "feat: один пик за заход вместо восьми карточек по бакетам"
```

---

### Task 5: Расписание, секреты, документация

**Files:**
- Modify: `.github/workflows/daily.yml`
- Modify: `README.md`

- [ ] **Step 1: Два расписания и укороченный таймаут**

В `.github/workflows/daily.yml` заменить блок `schedule`:

```yaml
on:
  schedule:
    # 06:00 UTC — утро (08:00 Europe/Warsaw летом, 07:00 зимой)
    - cron: '0 6 * * *'
    # 15:00 UTC — вечер (17:00 Europe/Warsaw летом, 16:00 зимой)
    - cron: '0 15 * * *'
  workflow_dispatch:
```

Заменить `timeout-minutes: 180` на `timeout-minutes: 45` и поправить комментарий над ним:

```yaml
    # Окно ожидания нажатий — 20 минут (LISTEN_MINUTES), плюс сбор кандидатов
    # до этого. 45 минут — бюджет с запасом, не ожидаемое время выполнения.
```

Убрать из `env` шага четыре канальные переменные, оставив:

```yaml
        env:
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          OWNER_CHAT_ID: ${{ secrets.OWNER_CHAT_ID }}
          LISTEN_MINUTES: '20'
```

Переименовать шаг с `Подобрать релизы и дождаться апрува` на `Подобрать альбом и отправить владельцу`.

- [ ] **Step 2: Проверить синтаксис workflow**

Run: `npx --yes js-yaml .github/workflows/daily.yml > /dev/null && echo OK`
Expected: `OK`

- [ ] **Step 3: Переписать README**

В `README.md`:
- в шапке заменить описание («присылает кандидатов владельцу на апрув и по кнопке публикует в один из четырёх каналов») на описание подборщика: дважды в день один альбом в личку, каналов нет;
- в разделе `bin/daily.ts` заменить пункты 3–5 на: один пик за заход, две кнопки (`👎 не моё` / `🔄 другой`), молчание ниже порога;
- в таблице файлов данных убрать из описания `state.json` слово «опубликовано» и упоминание `notices`, добавить `lastBucket`;
- в разделе про воркфлоу заменить `cron 0 6 * * *` на две строки расписания и таймаут 45.

- [ ] **Step 4: Финальная проверка**

Run: `npx tsc --noEmit && npm test`
Expected: `tsc` молчит, все тесты зелёные.

- [ ] **Step 5: Коммит**

```bash
git add .github/workflows/daily.yml README.md
git commit -m "chore: два расписания в сутки, без канальных секретов, обновлённый README"
```

---

## После выката, руками владельца

- Удалить в GitHub четыре секрета: `CRUST_CHANNEL_ID`, `DEATH_METAL_CHANNEL_ID`, `HARDCORE_PUNK_CHANNEL_ID`, `BLACK_METAL_CHANNEL_ID`.
- Удалить или заархивировать сами Telegram-каналы.
- Первую неделю смотреть, как часто заход молчит. Порог крутится переменной `MIN_TOTAL` без правки кода: молчит слишком часто — снижать, приходит проходняк — поднимать.
