# Подборщик становится только движком — план реализации (репозиторий `bandcamp-daily`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Убрать из `bandcamp-daily` весь телеграм-слой и хранение состояния: джоб читает контекст отбора с сайта, считает победителя и отдаёт его сайту одним запросом.

**Architecture:** Отбор (профиль, соседи, свежак, архив, скоринг, `pickBest`) остаётся нетронутым — это ценность репозитория. Всё, что было транспортом и состоянием, уходит: `src/telegram/`, `data/state.json`, окно ожидания, дренаж backlog, подчистка карточек, коммит состояния обратно в гит.

**Tech Stack:** Node 20, TypeScript через `tsx` (без шага сборки), `node:test`, GitHub Actions.

Спека: `big-s-studio/docs/superpowers/specs/2026-08-08-picker-on-site-design.md`

> ⛔ **Делать только ПОСЛЕ** плана `big-s-studio/docs/superpowers/plans/2026-08-08-picker-on-site.md`: до появления эндпоинтов `/api/picker/*` джобу некуда ходить, и проверить задачи будет нечем.

---

## Структура файлов

| Файл | Что с ним | Ответственность |
|---|---|---|
| `src/site/api.ts` | создать | HTTP-клиент сайта: контекст отбора и отправка пика |
| `src/site/api.test.ts` | создать | Тесты клиента на подменённом `fetch` |
| `src/pipeline/daily.ts` | править | `runDaily` без телеграма и без состояния |
| `bin/daily.ts` | править | Сборка зависимостей: сайт вместо Telegram и файлов |
| `src/telegram/` | удалить | Целиком: `api.ts`, `card.ts`, `approve.ts` и их тесты |
| `data/state.json` | удалить | Состояние живёт в Neon |
| `.github/workflows/daily.yml` | править | Секрет сайта вместо телеграмных, без шага коммита состояния |
| `README.md` | править | Описание новой роли репозитория |

---

### Task 1: Клиент сайта

**Files:**
- Create: `src/site/api.ts`, `src/site/api.test.ts`

- [ ] **Step 1: Падающие тесты**

Создать `src/site/api.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SiteApi } from './api.ts';

function stub(payload: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(payload), { status });
  }) as unknown as typeof fetch;
  return { api: new SiteApi('https://site.test', 'SECRET', impl), calls };
}

test('контекст запрашивается с Bearer-секретом', async () => {
  const { api, calls } = stub({ seen: ['u'], feedbackTags: { crust: 2 }, lastBucket: 'crust' });
  const ctx = await api.readContext();
  assert.equal(calls[0]?.url, 'https://site.test/api/picker/context');
  assert.equal((calls[0]?.init.headers as Record<string, string>).Authorization, 'Bearer SECRET');
  assert.deepEqual(ctx.seen, ['u']);
  assert.equal(ctx.lastBucket, 'crust');
});

test('пик уходит POST-ом с телом победителя', async () => {
  const { api, calls } = stub({ messageId: 7 });
  await api.sendPick({
    bucket: 'crust',
    candidate: { url: 'u', title: 'T', artist: 'A', label: null, tags: [], releasedAt: null, artUrl: null, origin: 'fresh' },
    matchedTags: ['crust'],
    total: 1.5,
    alternatives: [],
  });
  assert.equal(calls[0]?.url, 'https://site.test/api/picker/pick');
  assert.equal(calls[0]?.init.method, 'POST');
  assert.equal(JSON.parse(String(calls[0]?.init.body)).bucket, 'crust');
});

test('не-2xx превращается в понятную ошибку, а не в тихий undefined', async () => {
  const { api } = stub({ error: 'unauthorized' }, 401);
  await assert.rejects(() => api.readContext(), /401/);
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `npx tsx --test src/site/api.test.ts`
Expected: FAIL — модуля нет.

- [ ] **Step 3: Реализовать `src/site/api.ts`**

Класс `SiteApi` с конструктором `(baseUrl: string, secret: string, fetchImpl: typeof fetch = fetch)` и двумя методами:

- `readContext(): Promise<PickerContext>` — `GET {base}/api/picker/context`, заголовок `Authorization: Bearer {secret}`;
- `sendPick(pick: PickRequest): Promise<{ messageId: number }>` — `POST {base}/api/picker/pick`, тот же заголовок, `Content-Type: application/json`.

Не-2xx — исключение с методом, статусом и телом ответа в сообщении. Тихо возвращать пустой контекст нельзя: пустой `seen` означает «ничего не показывали», и джоб предложит владельцу то, что тот уже видел или скипнул. Такой сбой обязан ронять прогон, а не деградировать молча.

Типы `PickerContext`/`PickRequest` продублировать здесь, а не импортировать из сайта: репозитории деплоятся независимо: форма — контракт эндпоинта, и расхождение должно ловиться на границе.

- [ ] **Step 4: Прогнать тесты**

Run: `npx tsx --test src/site/api.test.ts`
Expected: 3 теста PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/site/api.ts src/site/api.test.ts
git commit -m "feat: клиент эндпоинтов подборщика на сайте"
```

---

### Task 2: `runDaily` без телеграма и состояния

**Files:**
- Modify: `src/pipeline/daily.ts`
- Test: `src/pipeline/daily.test.ts`

- [ ] **Step 1: Переписать тесты под новую форму**

Из `src/pipeline/daily.test.ts` удалить всё, что проверяет снятую механику: подчистку хвостов, дренаж backlog, окно опроса (`listenMinutes`), `editCard`, `loadConfig` в старой форме. Оставить тесты `hubTagsForBucket` — функция не меняется. Добавить:

```ts
test('runDaily: отдаёт победителя на сайт ровно один раз', async () => {
  const profile = fakeProfile();
  const sent: PickRequest[] = [];
  const deps: DailyDeps = {
    ...baseDeps(),
    site: {
      readContext: async () => ({ seen: [], feedbackTags: {}, lastBucket: null }),
      sendPick: async (pick) => {
        sent.push(pick);
        return { messageId: 1 };
      },
    },
  };

  await runDaily(profile, [], deps, baseOptions);

  assert.equal(sent.length, 1);
  assert.ok(sent[0]?.candidate.url);
});

test('runDaily: ниже порога не ходит на сайт вовсе', async () => {
  const profile = fakeProfile();
  let calls = 0;
  const deps: DailyDeps = {
    ...baseDeps(),
    site: {
      readContext: async () => ({ seen: [], feedbackTags: {}, lastBucket: null }),
      sendPick: async () => {
        calls += 1;
        return { messageId: 1 };
      },
    },
  };

  await runDaily(profile, [], deps, { ...baseOptions, minTotal: 99 });

  assert.equal(calls, 0, 'молчаливый заход не должен дёргать сайт пустым запросом');
});

test('runDaily: контекст с сайта попадает в отбор — показанное не предлагается снова', async () => {
  const profile = fakeProfile();
  const sent: PickRequest[] = [];
  const deps: DailyDeps = {
    ...baseDeps(),
    site: {
      // Всё, что мог бы предложить фейковый discover, уже показано.
      readContext: async () => ({ seen: [seededCandidateUrl], feedbackTags: {}, lastBucket: null }),
      sendPick: async (pick) => {
        sent.push(pick);
        return { messageId: 1 };
      },
    },
  };

  await runDaily(profile, [], deps, baseOptions);

  assert.equal(sent.length, 0);
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `npx tsc --noEmit`
Expected: FAIL — `DailyDeps` не знает поля `site`, а `runDaily` принимает `state`.

- [ ] **Step 3: Переписать `runDaily`**

Новая сигнатура — без `state`:

```ts
export async function runDaily(
  profile: Profile,
  neighbors: Neighbor[],
  deps: DailyDeps,
  options: DailyOptions,
): Promise<void>
```

Тело сокращается до: прочитать контекст с сайта → собрать `ownedUrls` → построить `excluded` из `seen` и `ownedUrls` → собрать `bucketInputs` по бакетам (этот блок не меняется) → `pickBest` с `tagPenalties` из контекста и `excludeBucket: ctx.lastBucket`, с тем же откатом при пустом пике → либо `deps.site.sendPick(...)`, либо лог и выход.

Удалить целиком: `sweepStaleMessages`, `editCard`, `EditableTelegram`, `DailyTelegramDeps`, `approveDeps`, дренаж backlog, цикл ожидания, `persistState`, `DailyOptions.listenMinutes`, `loadConfig` в старой форме (переменные теперь другие — см. Task 3).

Из `DailyDeps` уходят `telegram` и `persistState`, приходит `site: { readContext, sendPick }`.

- [ ] **Step 4: Прогнать**

Run: `npx tsc --noEmit && npx tsx --test src/pipeline/daily.test.ts`
Expected: чисто, тесты зелёные.

- [ ] **Step 5: Коммит**

```bash
git add src/pipeline/daily.ts src/pipeline/daily.test.ts
git commit -m "feat: заход отдаёт победителя сайту вместо отправки карточки"
```

---

### Task 3: Снести телеграм-слой и состояние

**Files:**
- Delete: `src/telegram/` целиком, `data/state.json`
- Modify: `bin/daily.ts`

- [ ] **Step 1: Убедиться, что на телеграм больше никто не ссылается**

Run: `grep -rn "telegram\|state.json" src bin --include="*.ts"`
Expected: только упоминания в комментариях, если остались, — их тоже вычистить.

- [ ] **Step 2: Удалить**

```bash
git rm -r src/telegram
git rm data/state.json
```

- [ ] **Step 3: Переписать `bin/daily.ts`**

Конфигурация теперь две переменные: `SITE_URL` (по умолчанию `https://gigamike666.com`) и `PICKER_SECRET` (обязательна). `TELEGRAM_BOT_TOKEN`, `OWNER_CHAT_ID`, `LISTEN_MINUTES` уходят.

Сборка зависимостей: `fresh`/`archive`/`fetchOwnedUrls`/`fetchFollowSubdomains` остаются как есть, вместо `telegram` и `persistState` — `site: new SiteApi(siteUrl, secret)`. Чтения `data/state.json` и `emptyState()` больше нет; `profile.json` и `neighbors.json` читаются по-прежнему.

Шапку файла переписать: она описывает старую модель с ожиданием нажатий.

- [ ] **Step 4: Проверить**

Run: `npx tsc --noEmit && npm test`
Expected: чисто, все тесты зелёные.

- [ ] **Step 5: Коммит**

```bash
git add -A src bin data
git commit -m "feat: убрать телеграм-слой и файл состояния"
```

---

### Task 4: Workflow

**Files:**
- Modify: `.github/workflows/daily.yml`

- [ ] **Step 1: Секреты и шаг коммита**

В `env` шага оставить `SITE_URL` и `PICKER_SECRET: ${{ secrets.PICKER_SECRET }}`; убрать `TELEGRAM_BOT_TOKEN`, `OWNER_CHAT_ID`, `LISTEN_MINUTES`.

**Удалить шаг «Сохранить состояние» целиком** — вместе с `git config`, `git add data/state.json`, циклом fetch+rebase+retry и правом `contents: write`. Джоб больше ничего не пишет в репозиторий: состояние живёт в Neon. Это заодно снимает всю гонку за пуш, ради которой писался тот цикл.

`permissions` сокращается до `contents: read`. Блок `concurrency` можно удалить: он существовал ради того, что два джоба пишут в `data/` и коммитят в одну ветку, — теперь не пишут.

Таймаут снизить с 45 до 20 минут: окна ожидания нет, остался только сбор кандидатов.

- [ ] **Step 2: Проверить YAML**

Run: `npx --yes js-yaml .github/workflows/daily.yml > /dev/null && echo "YAML OK"`
Expected: `YAML OK`

- [ ] **Step 3: Коммит**

```bash
git add .github/workflows/daily.yml
git commit -m "chore: джоб больше не пишет в репозиторий и не знает про Telegram"
```

---

### Task 5: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Переписать под новую роль**

Репозиторий больше не телеграм-бот, а движок рекомендаций. Что поправить:

- шапка: подбирает и отдаёт победителя сайту; карточку, кнопки и посты делает `gigamike666.com`;
- раздел про `bin/daily.ts`: шаги теперь «прочитать контекст → собрать → выбрать → отдать или промолчать», без окна ожидания и подчистки;
- таблица файлов данных: строка `data/state.json` уходит, вместо неё — фраза, что состояние (показанное, штрафы по тегам, жанр прошлого пика) живёт в Neon на стороне сайта;
- секреты: `SITE_URL` и `PICKER_SECRET` вместо телеграмных;
- раздел про CI: шага коммита состояния больше нет.

Разделы про `build-profile.ts`, `neighbors.ts`, скоринг, антипрофиль, дисковый кэш — верны, не трогать.

- [ ] **Step 2: Финальная проверка**

Run: `npx tsc --noEmit && npm test`
Expected: чисто, зелено.

- [ ] **Step 3: Коммит**

```bash
git add README.md
git commit -m "docs: репозиторий стал движком отбора, а не ботом"
```

---

## После выката, руками владельца

- Убедиться, что `PICKER_SECRET` в GitHub Secrets совпадает с тем, что в Vercel.
- Удалить из GitHub Secrets `TELEGRAM_BOT_TOKEN` и `OWNER_CHAT_ID` — джоб их больше не читает.
- Отозвать токен старого бота в BotFather.
- Первый прогон запустить руками через `workflow_dispatch` и посмотреть, что карточка пришла от блог-бота.
