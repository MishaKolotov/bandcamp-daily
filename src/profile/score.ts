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

/**
 * Минимальная сумма весов тегов, ниже которой релиз считается чужим.
 *
 * В `build.ts` опорный тег бакета (см. `seedTags` в `./buckets.ts`), если
 * пережил порог `minReleases`, зафиксирован ровно на 0.5 — а не-опорные
 * теги нормализованы к максимуму 1. Значение 0.5 здесь выбрано не
 * произвольно, а впритык под этот факт: релиз, несущий только опорный тег
 * бакета (что верно для КАЖДОГО релиза бакета по построению — см.
 * `bucketsOf`), даёт `tagScore === 0.5` и благодаря строгому неравенству
 * `<` всё ещё проходит порог, а не отбраковывается. Так и задумано в
 * `build.ts`: «релиз с одним лишь общим тегом всё ещё проходит порог
 * совпадения у скорера». Если бы порог оказался выше 0.5, скорер
 * отбраковывал бы вообще все релизы бакета до единого.
 */
const MATCH_FLOOR = 0.5;
/**
 * Совпадение, при котором стоп-тег уже не отбраковывает, а только штрафует.
 *
 * Опорный тег весит максимум 0.5, самый характерный не-опорный тег —
 * максимум 1 (см. `build.ts`), так что 1.5 — это ровно потолок «опорный
 * тег + топовый характерный тег»: максимально специфичное совпадение,
 * которое в принципе можно набрать двумя тегами. Если релиз настолько
 * точно лёг в профиль, шальной стоп-тег из мусорного тегирования Bandcamp
 * не должен убивать его целиком — только срезать очки.
 */
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
