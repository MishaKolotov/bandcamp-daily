import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeArtistName, pickExactMatch, searchBand, subdomainOf } from './search.ts';

const result = (over: Record<string, unknown> = {}) => ({
  type: 'b',
  name: 'Vladimir Dubyshkin',
  item_url_root: 'https://vladimirdubyshkin.bandcamp.com',
  tag_names: ['Electronic', 'techno'],
  genre_name: 'Electronic',
  location: 'Tambov, Russia',
  ...over,
});

test('нормализация переживает регистр, диакритику и пунктуацию', () => {
  assert.equal(normalizeArtistName('Këkht Aräkh'), 'kekht arakh');
  assert.equal(normalizeArtistName('Jak3 / Trashman'), 'jak3 trashman');
  assert.equal(normalizeArtistName('The Smiths'), 'smiths');
  assert.equal(normalizeArtistName('Guns & Roses'), 'guns and roses');
});

test('субдомен вынимается из item_url_root', () => {
  assert.equal(subdomainOf('https://vladimirdubyshkin.bandcamp.com'), 'vladimirdubyshkin');
  assert.equal(subdomainOf('https://example.com'), null);
  assert.equal(subdomainOf(undefined), null);
});

test('совпадение по имени возвращает теги и субдомен', () => {
  const match = pickExactMatch('Vladimir Dubyshkin', [result()]);
  assert.equal(match?.subdomain, 'vladimirdubyshkin');
  assert.deepEqual(match?.tags, ['Electronic', 'techno']);
});

test('genre_name добавляется к тегам, но не дублируется', () => {
  const match = pickExactMatch('X', [result({ name: 'X', tag_names: ['techno'], genre_name: 'techno' })]);
  assert.deepEqual(match?.tags, ['techno']);
});

test('чужой артист с похожим именем не принимается за своего', () => {
  // Автокомплит охотно отдаёт хоть что-то на любой запрос. Взять первое
  // попавшееся значило бы приписать владельцу теги случайной группы — а это
  // хуже пропуска: пропуск ничего не добавит, чужие теги отравят профиль.
  const match = pickExactMatch('Phantom', [result({ name: 'Phantom Thief' })]);
  assert.equal(match, null);
});

test('не-артисты (альбомы, лейблы-как-релизы) игнорируются', () => {
  const match = pickExactMatch('Institute', [result({ type: 'a', name: 'Institute' })]);
  assert.equal(match, null);
});

test('результат без субдомена пропускается, а не отдаётся полупустым', () => {
  const match = pickExactMatch('X', [result({ name: 'X', item_url_root: undefined })]);
  assert.equal(match, null);
});

test('searchBand шлёт имя в теле запроса и разбирает ответ', async () => {
  const calls: string[] = [];
  const fake = (async (_url: string, init: RequestInit) => {
    calls.push(String(init.body));
    return new Response(JSON.stringify({ auto: { results: [result()] } }), { status: 200 });
  }) as unknown as typeof fetch;

  const match = await searchBand('Vladimir Dubyshkin', fake);
  assert.equal(match?.name, 'Vladimir Dubyshkin');
  assert.ok(calls[0]?.includes('Vladimir Dubyshkin'));
});

test('пустая выдача — это null, а не исключение', async () => {
  const fake = (async () =>
    new Response(JSON.stringify({ auto: { results: [] } }), { status: 200 })) as unknown as typeof fetch;
  assert.equal(await searchBand('Cherrymoon Trax', fake), null);
});
