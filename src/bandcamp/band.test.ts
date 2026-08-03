import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseMusicGrid } from './band.ts';

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

test('треки-синглы отбрасываются, остаются альбомы', () => {
  const grid = `<ol id="music-grid" data-client-items="${JSON.stringify([
    { id: 1, title: 'A', artist: 'X', page_url: '/album/a', type: 'album' },
    { id: 2, title: 'B', artist: 'X', page_url: '/track/b', type: 'track' },
  ])
    .replaceAll('"', '&quot;')}"></ol>`;
  const releases = parseMusicGrid(grid, 'x');
  assert.deepEqual(releases.map((r) => r.url), ['https://x.bandcamp.com/album/a']);
});
