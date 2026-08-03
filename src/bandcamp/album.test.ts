import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseAlbumPage } from './album.ts';

const fixture = await readFile('test/fixtures/album-degraved.html', 'utf8');

test('вытаскивает название, артиста и лейбл', () => {
  const album = parseAlbumPage(fixture);
  assert.equal(album.title, 'Exhumed Remnants');
  assert.equal(album.artist, 'Degraved');
  assert.equal(album.label, 'Degraved');
});

test('теги приводятся к нижнему регистру', () => {
  const album = parseAlbumPage(fixture);
  assert.ok(album.tags.includes('death metal'));
  assert.ok(album.tags.includes('osdm'));
  assert.ok(!album.tags.some((t) => /[A-Z]/.test(t)), 'нашлись теги с заглавными буквами');
});

test('дата релиза переводится в ISO', () => {
  const album = parseAlbumPage(fixture);
  assert.equal(album.releasedAt, '2021-03-19');
});

test('обложка вытаскивается', () => {
  assert.match(parseAlbumPage(fixture).artUrl ?? '', /^https:\/\/f4\.bcbits\.com\/img\//);
});

test('страница без ld+json даёт понятную ошибку', () => {
  assert.throws(() => parseAlbumPage('<html><body>ничего</body></html>'), /ld\+json/);
});

test('отсутствующие необязательные поля не роняют парсер', () => {
  const minimal = `<script type="application/ld+json">${JSON.stringify({
    name: 'X',
    byArtist: { name: 'Y' },
  })}</script>`;
  const album = parseAlbumPage(minimal);
  assert.deepEqual(album, {
    title: 'X',
    artist: 'Y',
    label: null,
    tags: [],
    releasedAt: null,
    artUrl: null,
  });
});
