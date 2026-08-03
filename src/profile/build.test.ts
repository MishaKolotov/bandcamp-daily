import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProfile, type ProfileInput } from './build.ts';
import { BUCKETS } from './buckets.ts';

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

test('опорный тег бакета весит ровно 0.5 независимо от частоты', () => {
  const profile = buildProfile(
    [
      release({ tags: ['crust'] }),
      release({ tags: ['crust'] }),
      release({ tags: ['crust'] }),
      release({ tags: ['crust'] }),
    ],
    { now: new Date('2026-08-03'), minReleases: 1 },
  );
  assert.equal(profile.buckets.crust.tags['crust'], 0.5);
});

test('самый тяжёлый не-опорный тег весит ровно 1, опорный остаётся на 0.5', () => {
  const profile = buildProfile(
    [
      release({ tags: ['crust', 'raw'] }),
      release({ tags: ['crust', 'raw'] }),
      release({ tags: ['crust', 'raw'] }),
      release({ tags: ['crust', 'stenchy'] }),
      release({ tags: ['crust', 'stenchy'] }),
    ],
    { now: new Date('2026-08-03'), minReleases: 2 },
  );
  assert.equal(profile.buckets.crust.tags['raw'], 1);
  assert.ok(profile.buckets.crust.tags['stenchy']! < 1);
  assert.equal(profile.buckets.crust.tags['crust'], 0.5);
});

test('набор со специфичным тегом суммарно весит больше, чем набор с одним опорным', () => {
  const profile = buildProfile(
    [
      release({ tags: ['crust', 'raw'] }),
      release({ tags: ['crust', 'raw'] }),
      release({ tags: ['crust'] }),
    ],
    { now: new Date('2026-08-03'), minReleases: 2 },
  );
  const sumOf = (tags: string[]): number =>
    tags.reduce((total, tag) => total + (profile.buckets.crust.tags[tag] ?? 0), 0);
  assert.ok(sumOf(['crust', 'raw']) > sumOf(['crust']));
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

test('свежая покупка перевешивает старое желание, свежее желание — старую покупку', () => {
  const now = new Date('2026-08-03');

  const freshCollection = buildProfile(
    [release({ tags: ['crust'], addedAt: '2026-07-01', source: 'collection' })],
    { now, minReleases: 1 },
  );
  const staleWishlist = buildProfile(
    [release({ tags: ['crust'], addedAt: '2015-01-01', source: 'wishlist' })],
    { now, minReleases: 1 },
  );
  assert.ok(freshCollection.buckets.crust.weightSum > staleWishlist.buckets.crust.weightSum);

  const freshWishlist = buildProfile(
    [release({ tags: ['crust'], addedAt: '2026-07-01', source: 'wishlist' })],
    { now, minReleases: 1 },
  );
  const staleCollection = buildProfile(
    [release({ tags: ['crust'], addedAt: '2015-01-01', source: 'collection' })],
    { now, minReleases: 1 },
  );
  assert.ok(freshWishlist.buckets.crust.weightSum > staleCollection.buckets.crust.weightSum);
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

test('кроссовер-релиз питает статистику обоих совпавших бакетов', () => {
  // 'crust' задевает бакет crust, 'hardcore punk' задевает hardcore-punk —
  // релиз должен попасть в releaseCount и tags обоих, а не только первого
  // по порядку BUCKETS.
  const profile = buildProfile(
    [
      release({ tags: ['crust', 'hardcore punk'] }),
      release({ tags: ['crust', 'hardcore punk'] }),
    ],
    { now: new Date('2026-08-03'), minReleases: 2 },
  );
  assert.equal(profile.buckets.crust.releaseCount, 2);
  assert.equal(profile.buckets['hardcore-punk'].releaseCount, 2);
  assert.ok(profile.buckets.crust.tags['hardcore punk']! > 0);
  assert.ok(profile.buckets['hardcore-punk'].tags['crust']! > 0);
});

/**
 * Детерминированный генератор корпуса, формой похожего на реальные данные:
 * смесь коллекции/вишлиста, 3-6 тегов на релиз, часть релизов —
 * кроссоверы двух бакетов, часть — вовсе не жанровые, даты растянуты на
 * несколько лет. Никакой Math.random — тест воспроизводим.
 */
function generateCorpus(count: number): ProfileInput[] {
  const tagPools: readonly (readonly string[])[] = [
    ['crust', 'd-beat', 'raw', 'noise', 'discharge worship', 'anarcho'],
    ['death metal', 'osdm', 'gore', 'tech death', 'cavernous', 'brutal death metal'],
    ['hardcore punk', 'raw punk', 'youth crew', 'oi', 'melodic hardcore', 'ukhc'],
  ];
  const offGenreTags = ['ambient', 'experimental', 'field recording'];
  const labelPool: (string | null)[] = ['La Vida Es Un Mus', 'Halo of Flies', 'Selfmadegod', 'Prank', null];

  const dateFor = (i: number): string => {
    const year = 2018 + (i % 9);
    const month = String(1 + (i % 12)).padStart(2, '0');
    const day = String(1 + (i % 28)).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const items: ProfileInput[] = [];
  for (let i = 0; i < count; i++) {
    if (i % 17 === 0) {
      // релиз вне трёх жанров вообще
      items.push(
        release({
          tags: [offGenreTags[i % offGenreTags.length]!],
          label: labelPool[i % labelPool.length] ?? null,
          addedAt: dateFor(i),
          source: i % 3 === 0 ? 'wishlist' : 'collection',
        }),
      );
      continue;
    }

    const poolIndex = i % tagPools.length;
    const pool = tagPools[poolIndex]!;
    const isCrossover = i % 7 === 0;
    const otherPool = tagPools[(poolIndex + 1) % tagPools.length]!;
    const tagCount = 3 + (i % 4); // 3..6

    const tags: string[] = [];
    for (let t = 0; t < tagCount; t++) {
      const source = isCrossover && t % 2 === 1 ? otherPool : pool;
      const tag = source[(i * 3 + t) % source.length]!;
      if (!tags.includes(tag)) tags.push(tag);
    }

    items.push(
      release({
        tags,
        label: labelPool[i % labelPool.length] ?? null,
        addedAt: dateFor(i),
        source: i % 3 === 0 ? 'wishlist' : 'collection',
      }),
    );
  }
  return items;
}

test('на масштабе, близком к реальному корпусу, инварианты держатся', () => {
  const items = generateCorpus(320);
  const profile = buildProfile(items, { now: new Date('2026-08-03'), minReleases: 2 });

  for (const bucketDef of BUCKETS) {
    const bucket = profile.buckets[bucketDef.id];
    assert.ok(Number.isInteger(bucket.releaseCount));
    assert.ok(bucket.releaseCount >= 0 && bucket.releaseCount <= items.length);
    assert.ok(Number.isFinite(bucket.weightSum) && bucket.weightSum >= 0);

    const seedTags = new Set(bucketDef.seedTags.map((t) => t.toLowerCase()));
    const entries = Object.entries(bucket.tags);

    const nonSeedWeights: number[] = [];
    for (const [tag, weight] of entries) {
      assert.ok(Number.isFinite(weight), `вес тега "${tag}" не число`);
      assert.ok(!Number.isNaN(weight), `вес тега "${tag}" — NaN`);
      assert.ok(weight >= 0 && weight <= 1, `вес тега "${tag}" вне [0, 1]: ${weight}`);
      if (seedTags.has(tag)) {
        assert.equal(weight, 0.5, `опорный тег "${tag}" должен весить 0.5`);
      } else {
        nonSeedWeights.push(weight);
      }
    }
    if (nonSeedWeights.length > 0) {
      assert.equal(Math.max(...nonSeedWeights), 1);
    }
  }

  for (const [label, weight] of Object.entries(profile.labels)) {
    assert.ok(Number.isFinite(weight), `вес лейбла "${label}" не число`);
    assert.ok(weight >= 0 && weight <= 1, `вес лейбла "${label}" вне [0, 1]: ${weight}`);
  }
});
