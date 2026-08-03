import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Http } from '../lib/http.ts';
import { fetchBandReleases, parseMusicGrid } from './band.ts';

const fixture = await readFile('test/fixtures/music-grid.html', 'utf8');

test('дискография разбирается в список ссылок', () => {
  const releases = parseMusicGrid(fixture, 'lavidaesunmus');
  assert.ok(releases.length > 10, `разобрано ${releases.length} релизов`);
  assert.match(releases[0]?.url ?? '', /^https:\/\/lavidaesunmus\.bandcamp\.com\/album\//);
  assert.ok((releases[0]?.title ?? '').length > 0);
});

test('страница без грида (у группы один релиз) даёт пустой список', () => {
  assert.deepEqual(parseMusicGrid('<html><body>один альбом</body></html>', 'x'), []);
});

test('треки-синглы и сплиты сохраняются наравне с альбомами', () => {
  const grid = `<ol id="music-grid" data-client-items="${JSON.stringify([
    { id: 1, title: 'A', artist: 'X', page_url: '/album/a', type: 'album' },
    { id: 2, title: 'B', artist: 'X', page_url: '/track/b', type: 'track' },
  ])
    .replaceAll('"', '&quot;')}"></ol>`;
  const releases = parseMusicGrid(grid, 'x');
  assert.deepEqual(releases.map((r) => r.url), [
    'https://x.bandcamp.com/album/a',
    'https://x.bandcamp.com/track/b',
  ]);
});

test('data-client-items разбирается независимо от порядка атрибутов на теге', () => {
  const items = [{ id: 1, title: 'A', artist: 'X', page_url: '/album/a', type: 'album' }];
  const grid = `<ol data-client-items="${JSON.stringify(items).replaceAll(
    '"',
    '&quot;',
  )}" id="music-grid"></ol>`;
  const releases = parseMusicGrid(grid, 'x');
  assert.deepEqual(releases.map((r) => r.url), ['https://x.bandcamp.com/album/a']);
});

test('числовые и шестнадцатеричные HTML-сущности в названии разбираются', () => {
  // &#x27; — шестнадцатеричная сущность (обычный апостроф '), &#8217; — десятичная
  // (типографский апостроф ’). Ни та ни другая не встречаются в фикстуре, поэтому
  // проверяются на синтетических данных.
  const items = [
    { id: 1, title: 'Rock &#x27;n&#x27; Roll &#8217;Til I Die', artist: 'X', page_url: '/album/a', type: 'album' },
  ];
  const grid = `<ol id="music-grid" data-client-items="${JSON.stringify(items).replaceAll(
    '"',
    '&quot;',
  )}"></ol>`;
  const releases = parseMusicGrid(grid, 'x');
  assert.equal(releases[0]?.title, "Rock 'n' Roll ’Til I Die");
});

test('число вне диапазона Unicode остаётся текстом и не роняет разбор грида', () => {
  const items = [
    { id: 1, title: 'Cat &#999999999; Dog &#xFFFFFFFF;', artist: 'X', page_url: '/album/a', type: 'album' },
  ];
  const grid = `<ol data-client-items="${JSON.stringify(items).replaceAll('"', '&quot;')}"></ol>`;
  const releases = parseMusicGrid(grid, 'x');
  assert.equal(releases.length, 1, 'дискография не должна исчезать из-за одного символа');
  assert.equal(releases[0]?.title, 'Cat &#999999999; Dog &#xFFFFFFFF;');
});

test('реальная страница: заголовок с экранированным апострофом разбирается верно', () => {
  const releases = parseMusicGrid(fixture, 'lavidaesunmus');
  const release = releases.find((r) => r.url.endsWith('/album/societys-bastard'));
  assert.equal(release?.title, "Society's Bastard");
});

test('fetchBandReleases уважает лимит', async () => {
  const items = Array.from({ length: 20 }, (_, i) => ({
    id: i,
    title: `Release ${i}`,
    artist: 'X',
    page_url: `/album/release-${i}`,
    type: 'album',
  }));
  const html = `<ol id="music-grid" data-client-items="${JSON.stringify(items).replaceAll(
    '"',
    '&quot;',
  )}"></ol>`;
  const impl = (async () => new Response(html, { status: 200 })) as unknown as typeof fetch;
  const http = new Http({ fetchImpl: impl, minDelayMs: 0 });
  const releases = await fetchBandReleases(http, 'x', 5);
  assert.equal(releases.length, 5);
  assert.deepEqual(releases.map((r) => r.url), [
    'https://x.bandcamp.com/album/release-0',
    'https://x.bandcamp.com/album/release-1',
    'https://x.bandcamp.com/album/release-2',
    'https://x.bandcamp.com/album/release-3',
    'https://x.bandcamp.com/album/release-4',
  ]);
});

test('fetchBandReleases: недоступная страница даёт пустой список, а не исключение', async () => {
  const impl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
  const http = new Http({ fetchImpl: impl, minDelayMs: 0, retries: 0 });
  assert.deepEqual(await fetchBandReleases(http, 'x'), []);
});
