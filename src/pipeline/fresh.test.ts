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

const baseOptions = {
  tags: ['crust'],
  subdomains: [] as string[],
  now: new Date('2026-08-03'),
  maxAgeDays: 7,
  maxFutureDays: 30,
};

test('релизы из хаба и от подписок объединяются', async () => {
  const found = await freshCandidates(
    deps({
      discover: async () => [{ itemId: 1, url: 'https://a.test/album/1', title: 'A', artist: 'X', location: null }],
      bandReleases: async () => [{ url: 'https://b.test/album/2', title: 'B' }],
    }),
    { ...baseOptions, subdomains: ['b'] },
  );
  assert.deepEqual(found.map((c) => c.url).sort(), ['https://a.test/album/1', 'https://b.test/album/2']);
});

test('старые релизы отсекаются по дате', async () => {
  const found = await freshCandidates(
    deps({
      discover: async () => [{ itemId: 1, url: 'https://a.test/album/1', title: 'A', artist: 'X', location: null }],
      album: async () => album({ releasedAt: '2020-01-01' }),
    }),
    baseOptions,
  );
  assert.deepEqual(found, []);
});

test('релиз без даты не проходит — дату проверить нечем', async () => {
  const found = await freshCandidates(
    deps({
      discover: async () => [{ itemId: 1, url: 'https://a.test/album/1', title: 'A', artist: 'X', location: null }],
      album: async () => album({ releasedAt: null }),
    }),
    baseOptions,
  );
  assert.deepEqual(found, []);
});

test('предзаказ с датой в будущем считается свежим', async () => {
  const found = await freshCandidates(
    deps({
      discover: async () => [{ itemId: 1, url: 'https://a.test/album/1', title: 'A', artist: 'X', location: null }],
      album: async () => album({ releasedAt: '2026-09-01' }),
    }),
    baseOptions,
  );
  assert.equal(found.length, 1);
});

test('один и тот же релиз из двух источников не дублируется', async () => {
  const found = await freshCandidates(
    deps({
      discover: async () => [{ itemId: 1, url: 'https://a.test/album/1', title: 'A', artist: 'X', location: null }],
      bandReleases: async () => [{ url: 'https://a.test/album/1', title: 'A' }],
    }),
    { ...baseOptions, subdomains: ['a'] },
  );
  assert.equal(found.length, 1);
});

test('нечитаемая страница релиза просто выбрасывает кандидата', async () => {
  const found = await freshCandidates(
    deps({
      discover: async () => [{ itemId: 1, url: 'https://a.test/album/1', title: 'A', artist: 'X', location: null }],
      album: async () => null,
    }),
    baseOptions,
  );
  assert.deepEqual(found, []);
});

test('кандидат из подписки без числового id получает детерминированный itemId, а не 0', async () => {
  const runOnce = () =>
    freshCandidates(
      deps({
        bandReleases: async () => [{ url: 'https://b.test/album/2', title: 'B' }],
      }),
      { ...baseOptions, tags: [], subdomains: ['b'] },
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
    { ...baseOptions, tags: [], subdomains: ['b', 'c'] },
  );
  assert.equal(found.length, 2);
  assert.notEqual(found[0]?.itemId, found[1]?.itemId);
});

test('предзаказ ровно на границе maxFutureDays проходит', async () => {
  // '2026-08-03' -> +30 дней ровно = '2026-09-02'.
  const found = await freshCandidates(
    deps({
      discover: async () => [{ itemId: 1, url: 'https://a.test/album/1', title: 'A', artist: 'X', location: null }],
      album: async () => album({ releasedAt: '2026-09-02' }),
    }),
    baseOptions,
  );
  assert.equal(found.length, 1);
});

test('предзаказ дальше maxFutureDays отбрасывается', async () => {
  // На день дальше границы — '2026-09-03'.
  const found = await freshCandidates(
    deps({
      discover: async () => [{ itemId: 1, url: 'https://a.test/album/1', title: 'A', artist: 'X', location: null }],
      album: async () => album({ releasedAt: '2026-09-03' }),
    }),
    baseOptions,
  );
  assert.deepEqual(found, []);
});

test('пустые title/artist со страницы релиза подменяются данными источника', async () => {
  const found = await freshCandidates(
    deps({
      discover: async () => [
        { itemId: 1, url: 'https://a.test/album/1', title: 'Hub Title', artist: 'Hub Artist', location: null },
      ],
      album: async () => album({ title: '', artist: '' }),
    }),
    baseOptions,
  );
  assert.equal(found[0]?.title, 'Hub Title');
  assert.equal(found[0]?.artist, 'Hub Artist');
});

test('отброшенные из-за отсутствия даты кандидаты попадают в сводный warn, а не теряются молча', async () => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const found = await freshCandidates(
      deps({
        discover: async () => [
          { itemId: 1, url: 'https://a.test/album/1', title: 'A', artist: 'X', location: null },
          { itemId: 2, url: 'https://a.test/album/2', title: 'B', artist: 'Y', location: null },
        ],
        album: async (url) => (url.endsWith('/1') ? null : album({})),
      }),
      baseOptions,
    );
    assert.equal(found.length, 1);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]?.[0]), /1 из 2/);
  } finally {
    console.warn = originalWarn;
  }
});
