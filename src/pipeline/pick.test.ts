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
  ...over,
});

/** Профиль, где перечисленные теги весят заданное — чтобы total был предсказуем. */
const profileOf = (tags: Record<string, number>): BucketProfile => ({
  tags,
  stopTags: [],
  releaseCount: 10,
  weightSum: 1,
});

const bucketInput = (
  id: BucketId,
  tags: string[],
  seedTags: string[],
  weights: Record<string, number>,
): BucketInput => ({
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

test('запас «другой» собирается по всем бакетам, а не только по бакету победителя', () => {
  // Запас, ограниченный бакетом победителя, запирал владельца в одном жанре:
  // три нажатия «Другой» подряд выдавали три релиза того же жанра, потому что
  // взять что-то ещё было неоткуда. Здесь у краста и свой второй кандидат, и
  // конкурент из чужого бакета — в запасе обязаны быть оба, в порядке скора.
  const best = pickBest({
    ...base,
    buckets: [
      {
        id: 'crust',
        profile: profileOf({ crust: 0.5, 'd-beat': 1 }),
        seedTags: ['crust'],
        fresh: [
          candidate('https://x.test/a', ['crust', 'd-beat']),
          candidate('https://x.test/b', ['crust']),
        ],
        archive: [],
      },
      bucketInput('death-metal', ['death metal', 'hm-2'], ['death metal'], {
        'death metal': 0.5,
        'hm-2': 0.75,
      }),
    ],
  });

  assert.equal(best?.candidate.url, 'https://x.test/a', 'побеждает всё тот же максимальный total');
  assert.deepEqual(
    best?.alternatives.map((entry) => entry.candidate.url),
    ['https://x.test/death-metal', 'https://x.test/b'],
    'дэт-метал (1.25) идёт впереди второго краста (0.5) — запас упорядочен по скору, а не по жанру',
  );
  assert.deepEqual(
    best?.alternatives.map((entry) => entry.bucket),
    ['death-metal', 'crust'],
    'каждый вариант несёт свой бакет: по нему сайт перерисует жанр в подписи',
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

test('релиз, попавший и в свежак, и в архив, не становится сам себе «другим кандидатом»', () => {
  // Это тот случай, ради которого дедуп по URL вообще существует, и
  // единственный, где его отсутствие ВИДНО снаружи: один и тот же релиз
  // законно приходит из двух источников (подписка выпустила его сегодня — и
  // он же набрал голоса соседей в архивном пуле), причём с разными itemId
  // (у архивного это хеш URL, а не настоящий id Bandcamp). Без схлопывания
  // он занял бы и первое место, и первую строчку запаса — владелец нажал бы
  // «другой» и увидел ровно тот же альбом.
  const twice = ['crust', 'd-beat'];
  const best = pickBest({
    ...base,
    buckets: [
      {
        id: 'crust',
        profile: profileOf({ crust: 0.5, 'd-beat': 1 }),
        seedTags: ['crust'],
        fresh: [candidate('https://x.test/same', twice)],
        archive: [candidate('https://x.test/same', twice, { itemId: 777 })],
      },
    ],
  });
  assert.equal(best?.candidate.url, 'https://x.test/same');
  assert.deepEqual(
    best?.alternatives.map((entry) => entry.candidate.url),
    [],
    'дубль того же URL не имеет права попасть в запас «другой»',
  );
});

test('один и тот же релиз в двух бакетах достаётся тому, где совпадение сильнее', () => {
  const shared = ['crust', 'd-beat'];
  const best = pickBest({
    ...base,
    buckets: [
      {
        // Слабее: копия переживает скоринг (tagScore ровно 0.5 = MATCH_FLOOR,
        // проверка строгая `<`, опорный тег есть), но набирает меньше.
        id: 'hardcore-punk',
        profile: profileOf({ crust: 0.5, punk: 0.5 }),
        seedTags: ['crust'],
        fresh: [candidate('https://x.test/same', shared)],
        archive: [],
      },
      {
        id: 'crust',
        profile: profileOf({ crust: 0.5, 'd-beat': 1 }),
        seedTags: ['crust'],
        fresh: [candidate('https://x.test/same', shared)],
        archive: [],
      },
    ],
  });
  assert.equal(best?.bucket, 'crust', 'кроссовер достаётся бакету, чей профиль совпал сильнее');
});

test('порог держит и запас «другой», а не только победителя', () => {
  // Иначе подборщик обходит собственное решение через кнопку: победителя он
  // обязан выбрать выше minTotal, а подменяющего его кандидата — нет, и
  // первое же нажатие «другой» выдаёт ровно тот проходняк, ради неприсылки
  // которого схема и молчит.
  const best = pickBest({
    ...base,
    minTotal: 1.5,
    buckets: [
      {
        id: 'crust',
        profile: profileOf({ crust: 0.5, 'd-beat': 1 }),
        seedTags: ['crust'],
        fresh: [
          candidate('https://x.test/strong', ['crust', 'd-beat']), // 1.5 — проходит
          candidate('https://x.test/weak', ['crust']), // 0.5 — ниже порога
        ],
        archive: [],
      },
    ],
  });
  assert.equal(best?.candidate.url, 'https://x.test/strong');
  assert.deepEqual(best?.alternatives, [], 'кандидат ниже порога в запас не попадает');
});

test('первый запасной — другого жанра, даже если по скору впереди свой', () => {
  // Разделяющий случай. По чистому скору запас был бы
  // ['https://x.test/b' (0.9), 'https://x.test/death-metal' (0.5)] — то есть
  // первое нажатие «Другой» снова дало бы краст. Круг по жанрам ставит дэт
  // вперёд: бакет победителя уже высказался самим победителем.
  const best = pickBest({
    ...base,
    buckets: [
      {
        id: 'crust',
        profile: profileOf({ crust: 0.5, 'd-beat': 1, stenchcore: 0.4 }),
        seedTags: ['crust'],
        fresh: [
          candidate('https://x.test/a', ['crust', 'd-beat']),
          candidate('https://x.test/b', ['crust', 'stenchcore']),
        ],
        archive: [],
      },
      bucketInput('death-metal', ['death metal'], ['death metal'], { 'death metal': 0.5 }),
    ],
  });

  assert.equal(best?.candidate.url, 'https://x.test/a');
  assert.deepEqual(
    best?.alternatives.map((entry) => entry.bucket),
    ['death-metal', 'crust'],
    'первым обязан идти чужой жанр, вторым — второй краст',
  );
});

test('когда чужих жанров не осталось, запас честно добирается своим', () => {
  // Круг не должен превращаться в голодание: однородный запас лучше пустого.
  const best = pickBest({
    ...base,
    buckets: [
      {
        id: 'crust',
        profile: profileOf({ crust: 0.5, 'd-beat': 1, stenchcore: 0.4 }),
        seedTags: ['crust'],
        fresh: [
          candidate('https://x.test/a', ['crust', 'd-beat']),
          candidate('https://x.test/b', ['crust', 'stenchcore']),
          candidate('https://x.test/c', ['crust']),
        ],
        archive: [],
      },
    ],
  });

  assert.deepEqual(
    best?.alternatives.map((entry) => entry.candidate.url),
    ['https://x.test/b', 'https://x.test/c'],
    'единственный бакет отдаёт остаток по скору',
  );
});

test('круг по жанрам не обходит порог minTotal', () => {
  // Слабый кандидат чужого жанра не имеет права пролезть в запас только за то,
  // что он чужого жанра: порог — решение «лучше промолчать», и кнопка не должна
  // его обходить.
  const best = pickBest({
    ...base,
    minTotal: 0.75,
    buckets: [
      {
        id: 'crust',
        profile: profileOf({ crust: 0.5, 'd-beat': 1, stenchcore: 0.4 }),
        seedTags: ['crust'],
        fresh: [
          candidate('https://x.test/a', ['crust', 'd-beat']),
          candidate('https://x.test/b', ['crust', 'stenchcore']),
        ],
        archive: [],
      },
      bucketInput('death-metal', ['death metal'], ['death metal'], { 'death metal': 0.5 }),
    ],
  });

  assert.deepEqual(
    best?.alternatives.map((entry) => entry.candidate.url),
    ['https://x.test/b'],
    'дэт-метал (0.5) ниже порога 0.75 — в запас не попадает, несмотря на круг',
  );
});

test('запас не длиннее alternativesCount, сколько бы жанров ни было', () => {
  const best = pickBest({
    ...base,
    alternativesCount: 2,
    buckets: [
      bucketInput('crust', ['crust', 'd-beat'], ['crust'], { crust: 0.5, 'd-beat': 1 }),
      // Веса держатся над MATCH_FLOOR (0.5 в ../profile/score.ts): кандидат
      // слабее пола отбраковывается скорингом и до запаса вообще не доходит,
      // так что проверка длины на нём была бы пустой.
      bucketInput('death-metal', ['death metal'], ['death metal'], { 'death metal': 0.9 }),
      bucketInput('black-metal', ['black metal'], ['black metal'], { 'black metal': 0.8 }),
      bucketInput('hardcore-punk', ['hardcore punk'], ['hardcore punk'], { 'hardcore punk': 0.7 }),
    ],
  });

  assert.equal(best?.alternatives.length, 2);
});

test('очередь отдаётся целиком, если потолок её не режет', () => {
  // Очередь «Другой» листается, пока не кончится, — обрезать её на первых
  // нескольких значило бы закрывать карточку при живых кандидатах выше порога.
  const best = pickBest({
    ...base,
    alternativesCount: 40,
    buckets: [
      {
        id: 'crust',
        profile: profileOf({ crust: 0.5, 'd-beat': 1, stenchcore: 0.9, raw: 0.8, noise: 0.7 }),
        seedTags: ['crust'],
        fresh: [
          candidate('https://x.test/1', ['crust', 'd-beat']),
          candidate('https://x.test/2', ['crust', 'stenchcore']),
          candidate('https://x.test/3', ['crust', 'raw']),
          candidate('https://x.test/4', ['crust', 'noise']),
        ],
        archive: [],
      },
      bucketInput('death-metal', ['death metal'], ['death metal'], { 'death metal': 0.9 }),
    ],
  });

  assert.equal(best?.alternatives.length, 4, 'все прошедшие порог, кроме победителя, обязаны быть в очереди');
});
