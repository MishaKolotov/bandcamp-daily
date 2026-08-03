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
      discover: async () => [{ itemId: 1, url: 'https://a.test/album/1', title: 'A', artist: 'X' }],
      bandReleases: async () => [{ url: 'https://b.test/album/2', title: 'B' }],
    }),
    { tags: ['crust'], subdomains: ['b'], now: new Date('2026-08-03'), maxAgeDays: 7 },
  );
  assert.deepEqual(found.map((c) => c.url).sort(), ['https://a.test/album/1', 'https://b.test/album/2']);
});

test('старые релизы отсекаются по дате', async () => {
  const found = await freshCandidates(
    deps({
      discover: async () => [{ itemId: 1, url: 'https://a.test/album/1', title: 'A', artist: 'X' }],
      album: async () => album({ releasedAt: '2020-01-01' }),
    }),
    { tags: ['crust'], subdomains: [], now: new Date('2026-08-03'), maxAgeDays: 7 },
  );
  assert.deepEqual(found, []);
});

test('релиз без даты не проходит — дату проверить нечем', async () => {
  const found = await freshCandidates(
    deps({
      discover: async () => [{ itemId: 1, url: 'https://a.test/album/1', title: 'A', artist: 'X' }],
      album: async () => album({ releasedAt: null }),
    }),
    { tags: ['crust'], subdomains: [], now: new Date('2026-08-03'), maxAgeDays: 7 },
  );
  assert.deepEqual(found, []);
});

test('предзаказ с датой в будущем считается свежим', async () => {
  const found = await freshCandidates(
    deps({
      discover: async () => [{ itemId: 1, url: 'https://a.test/album/1', title: 'A', artist: 'X' }],
      album: async () => album({ releasedAt: '2026-09-01' }),
    }),
    { tags: ['crust'], subdomains: [], now: new Date('2026-08-03'), maxAgeDays: 7 },
  );
  assert.equal(found.length, 1);
});

test('один и тот же релиз из двух источников не дублируется', async () => {
  const found = await freshCandidates(
    deps({
      discover: async () => [{ itemId: 1, url: 'https://a.test/album/1', title: 'A', artist: 'X' }],
      bandReleases: async () => [{ url: 'https://a.test/album/1', title: 'A' }],
    }),
    { tags: ['crust'], subdomains: ['a'], now: new Date('2026-08-03'), maxAgeDays: 7 },
  );
  assert.equal(found.length, 1);
});

test('нечитаемая страница релиза просто выбрасывает кандидата', async () => {
  const found = await freshCandidates(
    deps({
      discover: async () => [{ itemId: 1, url: 'https://a.test/album/1', title: 'A', artist: 'X' }],
      album: async () => null,
    }),
    { tags: ['crust'], subdomains: [], now: new Date('2026-08-03'), maxAgeDays: 7 },
  );
  assert.deepEqual(found, []);
});

test('кандидат из подписки без числового id получает детерминированный itemId, а не 0', async () => {
  const runOnce = () =>
    freshCandidates(
      deps({
        bandReleases: async () => [{ url: 'https://b.test/album/2', title: 'B' }],
      }),
      { tags: [], subdomains: ['b'], now: new Date('2026-08-03'), maxAgeDays: 7 },
    );
  const first = await runOnce();
  const second = await runOnce();
  assert.equal(first.length, 1);
  assert.notEqual(first[0]?.itemId, 0);
  // Стабильность между прогонами — на itemId завязаны дедуп «уже показано»
  // и callback_data кнопок в Telegram (см. Task 15/17), значение обязано
  // не плавать от запуска к запуску для одного и того же URL.
  assert.equal(first[0]?.itemId, second[0]?.itemId);
});

test('два разных релиза из подписок получают разные itemId', async () => {
  const found = await freshCandidates(
    deps({
      bandReleases: async (subdomain) =>
        subdomain === 'b'
          ? [{ url: 'https://b.test/album/2', title: 'B' }]
          : [{ url: 'https://c.test/album/3', title: 'C' }],
    }),
    { tags: [], subdomains: ['b', 'c'], now: new Date('2026-08-03'), maxAgeDays: 7 },
  );
  assert.equal(found.length, 2);
  assert.notEqual(found[0]?.itemId, found[1]?.itemId);
});
