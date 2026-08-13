# Только новинки: удаление архивной половины — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Подборщик присылает только свежие релизы; граф соседей, архивный пул и недельный пересчёт удаляются целиком.

**Architecture:** Чистое удаление одной из двух веток пайплайна. Свежак не трогаем. Контракт с сайтом (`SiteCandidate`) сохраняет поле `origin` — сайт валидирует тело зодом и рендерит по нему текст карточки; наружу теперь всегда уходит `'fresh'`. Внутренний `Candidate` поле `origin` и `neighborWeight` теряет совсем.

**Tech Stack:** как в репо — Node 20, tsx, node:test, ноль зависимостей.

**Спека:** `docs/superpowers/specs/2026-08-04-fresh-only-design.md`.

Контекст для исполнителя с нуля: этот репозиторий — движок отбора без состояния. Три раза в сутки GitHub Actions запускает `bin/daily.ts`: собрать кандидатов по всем бакетам, выбрать ОДНОГО победителя (`pickBest` в `src/pipeline/pick.ts`), отдать его сайту gigamike666.com (`src/site/api.ts`), который держит Telegram-вебхук и состояние в Neon. Архивная ветка — кандидаты из коллекций «соседей по вкусу» (`data/neighbors.json`, пересчитывался недельным воркфлоу) — удаляется.

---

### Task 1: `Candidate` без `origin` и `neighborWeight`

**Files:**
- Modify: `src/bandcamp/types.ts` (интерфейс `Candidate`)
- Modify: `src/pipeline/fresh.ts` (конструирование кандидатов — убрать `origin: 'fresh'`)
- Modify: `src/pipeline/daily.ts` (`toSiteCandidate` — `origin: 'fresh'` литералом)
- Modify: `src/site/api.ts` — НЕ трогать форму `SiteCandidate` (контракт сайта), только убедиться, что `origin: 'fresh' | 'archive'` остаётся
- Modify: `src/profile/score.ts:224` и `src/lib/hash.ts:20-22` — комментарии, ссылающиеся на archive.ts/соседей, переписать под новую реальность
- Tests: правки в `src/pipeline/fresh.test.ts`, `src/pipeline/daily.test.ts` по компилятору

- [ ] **Step 1:** В `src/bandcamp/types.ts` удалить из `Candidate` поля `origin` и `neighborWeight` вместе с их JSDoc.
- [ ] **Step 2:** `npx tsc --noEmit` — собрать список всех мест, которые перестали компилироваться. Ожидаются: `fresh.ts` (проставлял `origin`), `daily.ts` (`toSiteCandidate` читал `candidate.origin`), `pick.ts` (комментарии не считаются), тестовые фикстуры.
- [ ] **Step 3:** В `src/pipeline/fresh.ts` убрать `origin: 'fresh'` из литерала кандидата. В `src/pipeline/daily.ts` в `toSiteCandidate` заменить `origin: candidate.origin` на `origin: 'fresh'` с комментарием: контракт сайта не меняем, сайт валидирует поле зодом; архивной ветки больше нет, значение всегда `'fresh'`.
- [ ] **Step 4:** Пройти по фикстурам тестов (`fresh.test.ts`, `daily.test.ts`, `pick.test.ts`) и убрать `origin`/`neighborWeight` из литералов `Candidate`. Ничего не ослаблять: ассерты на `origin` в отправке к сайту заменить на ассерт `origin === 'fresh'` всегда.
- [ ] **Step 5:** Переписать устаревшие комментарии в `score.ts` и `hash.ts` (оба ссылаются на архив/соседей как на живой код).
- [ ] **Step 6:** `npx tsc --noEmit` чисто; `npm test` — падают только тесты ещё не удалённых `archive/neighbors/collectors` модулей, остальное зелёное.
- [ ] **Step 7:** Коммит: `refactor: у кандидата один источник — origin и neighborWeight сняты`

### Task 2: `pick.ts` без архивного пула

**Files:**
- Modify: `src/pipeline/pick.ts` (`BucketInput.archive`, слияние пулов на строке ~196, комментарии ~46, ~191-196, ~211)
- Test: `src/pipeline/pick.test.ts`

- [ ] **Step 1:** Удалить поле `archive: Candidate[]` из `BucketInput`; в `pickBest` цикл `for (const candidate of [...bucket.fresh, ...bucket.archive])` заменить на `for (const candidate of bucket.fresh)`. Комментарий о слиянии пулов удалить, комментарий про вторичный ключ сортировки поправить (упоминает порядок `fresh`/`archive`).
- [ ] **Step 2:** В `pick.test.ts` убрать `archive: []` из фикстур; тесты, проверявшие слияние/дедуп между пулами, удалить, зафиксировав в коммит-сообщении, какие. Тесты дедупа по URL между бакетами оставить — они не про архив.
- [ ] **Step 3:** `npx tsc --noEmit` и `node --import tsx --test src/pipeline/pick.test.ts` — чисто.
- [ ] **Step 4:** Коммит: `refactor: pickBest ранжирует только свежак`

### Task 3: `daily.ts` и `bin/daily.ts` без соседей

**Files:**
- Modify: `src/pipeline/daily.ts` — снять `import { archiveCandidates, type ArchiveDeps }`, `import type { Neighbor }`, поле `DailyDeps.archive`, опцию `DailyOptions.archivePoolLimit`, параметр `neighbors` у `runDaily`, блок сборки `archivePool` (~строки 251-259), `archive: archivePool` в `bucketInputs`
- Modify: `bin/daily.ts` — снять чтение `data/neighbors.json`, `PATHS.neighbors`, `import type { Neighbor }`, деп `archive`, передачу `archivePoolLimit`
- Test: `src/pipeline/daily.test.ts`

- [ ] **Step 1:** Правки по списку выше; `npx tsc --noEmit` ведёт по хвостам.
- [ ] **Step 2:** В `daily.test.ts` убрать фикстуры соседей/архивного пула; тест «соседей нет — свежак всё равно собирается» удалить как беспредметный. Убедиться, что тест на «один упавший бакет не тащит остальные» остался — он про свежак.
- [ ] **Step 3:** `npm test` — падают только тесты модулей, удаляемых в Task 4.
- [ ] **Step 4:** Коммит: `refactor: ежедневный заход собирает только свежак`

### Task 4: удалить файлы и воркфлоу

**Files:**
- Delete: `src/pipeline/archive.ts`, `src/pipeline/archive.test.ts`, `src/pipeline/neighbors.ts`, `src/pipeline/neighbors.test.ts`, `src/bandcamp/collectors.ts`, `src/bandcamp/collectors.test.ts`, `bin/neighbors.ts`, `.github/workflows/neighbors-weekly.yml`, `data/neighbors.json`
- Modify: `package.json` (скрипт `neighbors`), `.github/workflows/daily.yml:35` (комментарий про общую с neighbors-weekly группу concurrency)

- [ ] **Step 1:** `git rm` всех девяти файлов, убрать скрипт `"neighbors"` из package.json, поправить комментарий в daily.yml.
- [ ] **Step 2:** `grep -rn "neighbor\|archiveCandidates\|fetchCollectors" src bin .github package.json README.md` — ноль совпадений в коде; допустимы только исторические упоминания в docs/.
- [ ] **Step 3:** `npx tsc --noEmit` и `npm test` — всё зелёное, число тестов упало ровно на удалённые файлы.
- [ ] **Step 4:** Коммит: `feat: только новинки — архивная половина удалена`

### Task 5: документация и финальная проверка

**Files:**
- Modify: `README.md` — раздел про `bin/neighbors.ts`, упоминания архива/соседей в описании пайплайна и файлов данных
- Modify: `docs/superpowers/plans/2026-08-03-bandcamp-daily.md` — в раздел «Решения, принятые по ходу реализации» дописать пунктом: архивная ветка удалена по решению владельца 2026-08-04, только свежак (пп. про соседей остаются как история)

- [ ] **Step 1:** Правки документации.
- [ ] **Step 2:** Полный прогон: `npx tsc --noEmit`, `npm test`.
- [ ] **Step 3:** Живой смок: `PICKER_SECRET=... npm run daily` НЕ запускать без владельца — вместо этого `node --import tsx -e` импортировать `runDaily` не нужно; достаточно, что юнит-тесты `daily.test.ts` зелёные. Отметить в отчёте, что живой прогон случится ближайшим заходом по расписанию и его стоит глянуть глазами.
- [ ] **Step 4:** Коммит: `docs: только новинки`; пуш в `main`.

## Self-review

Спека покрыта: удаление всех восьми артефактов — Task 4; `select.ts` из спеки в реальности называется `pick.ts` — Task 2; «до 4 карточек вместо 8» из спеки устарело ещё до этого плана (теперь один победитель на заход) — поведение «🔄 Другой» только по свежаку получается само из Task 2/3. Контракт сайта не ломается: `origin` остаётся в проводе со значением `'fresh'`.
