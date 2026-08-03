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
