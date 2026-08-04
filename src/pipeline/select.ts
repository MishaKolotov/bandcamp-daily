import type { Candidate } from '../bandcamp/types.ts';
import type { BucketProfile } from '../profile/build.ts';
import { score, type ScoreContext } from '../profile/score.ts';

/** Кандидат, выбранный как лучший в своём пуле, плюс запас на «другой». */
export interface Pick {
  candidate: Candidate;
  /** Совпавшие теги по убыванию веса — материал для строки «почему» в карточке. */
  matchedTags: string[];
  total: number;
  /**
   * Следующие по скору кандидаты того же пула — на случай нажатия «другой
   * кандидат» (см. `handleNext` в `../telegram/approve.ts`). Никогда не
   * содержит URL самого `candidate` этого исхода и никогда не содержит URL,
   * уже занятый исходом ДРУГОГО пула (`fresh`/`archive`) этого же вызова —
   * иначе «другой кандидат» под одной карточкой мог бы показать релиз,
   * который в этот же день уже показан владельцу как основной пик соседней
   * карточки.
   */
  alternatives: Candidate[];
}

/**
 * Итог отбора для одного пула (свежак или архив) внутри бакета.
 *
 * Пустой пул на входе и пул, который целиком отсеялся скорингом/уже
 * показанным, — по факту разные вещи для того, кто читает результат:
 * `not-offered` — пулу нечего было предложить (пустой сырой массив на
 * входе: например, подписки в этот день не выдали ничего свежего, или
 * архивный пул для прогона ещё не посчитан), `no-match` — предлагали, но
 * бакету не подошло ни одного (профиль отбраковал скорингом, или всё уже
 * показывалось раньше, или единственный кандидат оказался занят другим
 * пулом). Раньше оба случая тонули в одном и том же пустом массиве;
 * теперь это два явных варианта дискриминированного union, различимых по
 * `status`, а не два разных пути к одному и тому же `[]`.
 */
export type PoolOutcome = ({ status: 'picked' } & Pick) | { status: 'not-offered' } | { status: 'no-match' };

export interface BucketSelection {
  fresh: PoolOutcome;
  archive: PoolOutcome;
}

export interface SelectOptions {
  bucket: BucketProfile;
  /**
   * Опорные теги бакета (см. `seedTags` в `../profile/buckets.ts`) —
   * прокидываются насквозь до `score()`, который требует хотя бы один из
   * них у любого кандидата (см. комментарий у `hasSeedTag` в
   * `../profile/score.ts`). Обязательное поле по той же причине, по которой
   * сам `score()` требует его обязательным аргументом, а не опциональным —
   * забытое поле должно ронять компиляцию, а не тихо менять поведение.
   */
  seedTags: readonly string[];
  fresh: Candidate[];
  archive: Candidate[];
  /**
   * URL релизов, которые уже показывались владельцу — ключ URL, а НЕ
   * itemId (см. "Решения, принятые по ходу реализации" в плане, п.1: у
   * релиза, найденного через дискографию подписки, itemId — детерминированный
   * хеш URL, а не настоящий id Bandcamp, так что itemId не сравним между
   * источниками; единственный стабильный ключ между `fresh.ts`, `archive.ts`
   * и этой функцией — URL).
   */
  seen: ReadonlySet<string>;
  context: ScoreContext;
  alternativesCount: number;
}

interface RankedEntry {
  candidate: Candidate;
  matchedTags: string[];
  total: number;
}

/**
 * Схлопывает кандидатов одного пула по URL. Один и тот же релиз может
 * прийти дважды под разными itemId из разных источников (тег-хаб Discover
 * даёт настоящий item_id, дискография подписки — хеш URL, сосед в архивном
 * пуле — снова настоящий item_id) — при коллизии побеждает МЕНЬШИЙ itemId,
 * а не первый по порядку массива: порядок, в котором сеть вернула
 * кандидатов, не гарантирован между прогонами, а исход отбора обязан быть
 * детерминированным независимо от него.
 */
function dedupeByUrl(candidates: Candidate[]): Candidate[] {
  const byUrl = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const existing = byUrl.get(candidate.url);
    if (!existing || candidate.itemId < existing.itemId) byUrl.set(candidate.url, candidate);
  }
  return [...byUrl.values()];
}

/**
 * Ранжирует один пул: убирает дубликаты по URL (см. `dedupeByUrl`), убирает
 * уже занятые URL (`excluded` — показанное ранее плюс, для архива, URL,
 * уже занятый свежаком в этом же вызове), отбраковывает скорингом,
 * сортирует по убыванию total.
 *
 * Равный total — не редкость (совпадение по одному и тому же набору тегов
 * бакета даёт одинаковую сумму весов у разных релизов), а порядок
 * кандидатов на входе не гарантирован между прогонами (сеть, порядок
 * ответа соседей и т.п.). Вторичный ключ сортировки — URL как строка: сам
 * по себе он не несёт никакого смысла, но он стабилен и есть у каждого
 * кандидата, так что результат перестаёт зависеть от порядка на входе.
 */
function rankPool(
  pool: Candidate[],
  bucket: BucketProfile,
  seedTags: readonly string[],
  context: ScoreContext,
  excluded: ReadonlySet<string>,
): RankedEntry[] {
  return dedupeByUrl(pool)
    .filter((candidate) => !excluded.has(candidate.url))
    .map((candidate) => ({ candidate, result: score(candidate, bucket, seedTags, context) }))
    .filter((entry) => !entry.result.rejected)
    .sort((a, b) => {
      if (b.result.total !== a.result.total) return b.result.total - a.result.total;
      return a.candidate.url < b.candidate.url ? -1 : a.candidate.url > b.candidate.url ? 1 : 0;
    })
    .map((entry) => ({
      candidate: entry.candidate,
      matchedTags: entry.result.reasons,
      total: entry.result.total,
    }));
}

/**
 * Собирает исход одного пула из уже отранжированного списка.
 *
 * `rawPoolSize` — размер СЫРОГО пула на входе (до дедупа и фильтров): если
 * он 0, пулу нечего было предложить (`not-offered`); если он больше 0, но
 * `ranked` пуст, значит что-то предлагали, но ничего не подошло
 * (`no-match`). `otherPickUrl`, если задан, вычёркивается и из кандидата в
 * пики (уже сделано на уровне `excluded` в `rankPool` для архива), и из
 * запаса — нужен здесь отдельно для свежака, чей ранжированный список
 * строится ДО того, как известен архивный пик.
 */
function buildOutcome(
  rawPoolSize: number,
  ranked: RankedEntry[],
  otherPickUrl: string | undefined,
  alternativesCount: number,
): PoolOutcome {
  const top = ranked[0];
  if (!top) return rawPoolSize === 0 ? { status: 'not-offered' } : { status: 'no-match' };
  const alternatives = ranked
    .slice(1)
    .filter((entry) => entry.candidate.url !== otherPickUrl)
    .slice(0, alternativesCount)
    .map((entry) => entry.candidate);
  return { status: 'picked', candidate: top.candidate, matchedTags: top.matchedTags, total: top.total, alternatives };
}

/**
 * По одному лучшему свежему и архивному релизу на бакет, плюс запас на
 * «другой кандидат» в каждом.
 *
 * Свежак ранжируется первым, и его URL исключается из рассмотрения архива —
 * если один и тот же релиз оказался лучшим кандидатом сразу в обоих пулах
 * (подписка выпустила релиз, который в тот же день набрал голоса соседей),
 * он уходит владельцу один раз, как свежак, а архив ищет следующий по
 * скору. Выбор в пользу свежака, а не архива: релиз, вышедший сегодня,
 * важнее показать со штампом «вышло сегодня», чем со штампом «откопано у
 * соседей» — а архивный пул общий на все четыре бакета (см. план, пункт 6)
 * и на следующий день предложит что-то ещё.
 *
 * Сеть и файлы эта функция не трогает вообще — оба пула и множество
 * показанного передаются уже готовыми.
 */
export function selectForBucket(options: SelectOptions): BucketSelection {
  const freshRanked = rankPool(options.fresh, options.bucket, options.seedTags, options.context, options.seen);
  const freshTop = freshRanked[0];

  const claimedByFresh = freshTop ? new Set([...options.seen, freshTop.candidate.url]) : options.seen;
  const archiveRanked = rankPool(options.archive, options.bucket, options.seedTags, options.context, claimedByFresh);
  const archiveTop = archiveRanked[0];

  const fresh = buildOutcome(options.fresh.length, freshRanked, archiveTop?.candidate.url, options.alternativesCount);
  const archive = buildOutcome(options.archive.length, archiveRanked, undefined, options.alternativesCount);

  return { fresh, archive };
}
