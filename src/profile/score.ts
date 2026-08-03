import type { Candidate } from '../bandcamp/types.ts';
import type { BucketProfile } from './build.ts';
import { canonicalizeTag } from '../lib/tags.ts';

export interface ScoreContext {
  /** Лейбл → вес 0..1 из профиля. */
  labels?: Record<string, number>;
  /** Тег → сколько раз владелец скипнул релиз с этим тегом. */
  tagPenalties?: Record<string, number>;
}

export interface ScoreResult {
  total: number;
  rejected: boolean;
  /**
   * Совпавшие теги по убыванию веса — из них строится строка «почему это
   * тебе». Имеет смысл только при `rejected: false`; при отбраковке всегда
   * `[]` — совпадения были, но релиз всё равно убит стоп-тегом или
   * штрафами, и показывать их как «почему это тебе» было бы враньём.
   */
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
/**
 * Потолок суммарного анти-фидбек штрафа по всем тегам кандидата.
 *
 * Без потолка штраф копится бесконечно и без затухания: 0.25 за каждый
 * скип по каждому тегу. А опорный тег бакета несёт КАЖДЫЙ релиз бакета по
 * построению (см. `bucketsOf`), так что каждый скип наращивает счётчик
 * именно опорного тега — независимо от того, что владелец скипнул. При
 * максимуме позитивного скора около 3 десятка скипов чего угодно из
 * бакета доводят даже идеальное совпадение до нуля, и с этого момента
 * канал отбраковывает всё подряд без шанса на восстановление — при паре
 * скипов в неделю это месяц-два до тихой смерти канала. Потолок в 1
 * оставляет штраф значимым: слабое совпадение он всё ещё топит целиком, но
 * сильное совпадение переживает даже большой обвал по одному тегу.
 */
const FEEDBACK_PENALTY_CAP = 1;

export function score(
  candidate: Candidate,
  bucket: BucketProfile,
  context: ScoreContext,
): ScoreResult {
  const tags = candidate.tags.map((tag) => tag.toLowerCase());

  // `bucket.tags`/`bucket.stopTags` приходят из data/profile.json, который
  // хозяин правит руками — он мог вписать туда любое из трёх написаний тега
  // ('crust punk' / 'crust-punk' / 'crustpunk'), а Bandcamp мог тегировать
  // КОНКРЕТНЫЙ релиз иначе, чем написано в профиле. Сравниваем по
  // каноническому ключу (см. `canonicalizeTag` в `../lib/tags.ts`), а не по
  // точной строке — иначе совпадение молча терялось бы всякий раз, когда
  // написания расходятся.
  const weightByCanonicalTag = new Map<string, number>();
  for (const [tag, weight] of Object.entries(bucket.tags)) {
    const key = canonicalizeTag(tag);
    // Если профиль (руками) содержит два написания одного тега — берём
    // большее, а не складываем: это по-прежнему ОДИН тег, суммирование
    // задвоило бы сигнал совпадения без всякого основания.
    const existing = weightByCanonicalTag.get(key);
    if (existing === undefined || weight > existing) weightByCanonicalTag.set(key, weight);
  }
  const stopTagsCanonical = new Set(bucket.stopTags.map(canonicalizeTag));

  const matched = tags
    .map((tag) => ({ tag, weight: weightByCanonicalTag.get(canonicalizeTag(tag)) ?? 0 }))
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight);
  const tagScore = matched.reduce((sum, entry) => sum + entry.weight, 0);

  const stopHits = tags.filter((tag) => stopTagsCanonical.has(canonicalizeTag(tag))).length;
  if (tagScore < MATCH_FLOOR || (stopHits > 0 && tagScore < STRONG_MATCH)) {
    // reasons: [] — см. комментарий на поле в ScoreResult: при отбраковке
    // совпавшие теги не годятся в «почему это тебе».
    return { total: 0, rejected: true, reasons: [] };
  }

  const labelKey = candidate.label?.trim().toLowerCase() ?? '';
  const labelBonus = 0.7 * (context.labels?.[labelKey] ?? 0);
  // alsoCollected у свежих кандидатов всегда 0 — Discover-ответ Bandcamp его
  // не отдаёт, так что этот член фактически различает только внутри пула
  // архивных кандидатов. Это безопасно, пока свежий и архивный пул ранжирует
  // отдельно шаг отбора; если пулы когда-нибудь объединят в один общий
  // рейтинг, свежие релизы окажутся молча обделены этим бонусом.
  const popularity = Math.min(0.5, 0.15 * Math.log10(1 + candidate.alsoCollected));
  const stopPenalty = 0.8 * stopHits;
  const feedbackPenalty = Math.min(
    FEEDBACK_PENALTY_CAP,
    tags.reduce((sum, tag) => sum + 0.25 * (context.tagPenalties?.[tag] ?? 0), 0),
  );

  const total = tagScore + labelBonus + popularity - stopPenalty - feedbackPenalty;
  const rejected = total <= 0;
  return {
    // Обе ветки отбраковки репортят total: 0 — форма результата не должна
    // зависеть от того, КАКОЙ порог сработал (совпадение тегов или штрафы
    // увели итог в минус). Иначе читатель/логгер результата вынужден сам
    // разбираться, что означает отрицательное число рядом с rejected: true.
    total: rejected ? 0 : Number(total.toFixed(3)),
    rejected,
    reasons: rejected ? [] : matched.map((entry) => entry.tag),
  };
}
