import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candidate } from '../bandcamp/types.ts';
import { buildCard, buildChannelPost, parseCallback } from './card.ts';

const candidate: Candidate = {
  itemId: 42,
  url: 'https://label.bandcamp.com/album/a',
  title: 'Album <Name>',
  artist: 'Band & Co',
  label: 'La Vida Es Un Mus',
  tags: ['crust', 'd-beat'],
  releasedAt: '2026-08-01',
  artUrl: 'https://f4.bcbits.com/img/a1_10.jpg',
  alsoCollected: 120,
  origin: 'fresh',
};

test('в подписке есть артист, альбом, теги и ссылка', () => {
  const card = buildCard(candidate, 'crust', ['crust', 'd-beat']);
  assert.match(card.caption, /Band &amp; Co/);
  assert.match(card.caption, /Album &lt;Name&gt;/);
  assert.match(card.caption, /crust/);
  assert.match(card.caption, /https:\/\/label\.bandcamp\.com\/album\/a/);
});

test('угловые скобки и амперсанды экранируются — иначе Telegram отвергнет HTML', () => {
  const card = buildCard(candidate, 'crust', []);
  assert.ok(!card.caption.includes('<Name>'));
});

test('подпись не превышает лимит Telegram в 1024 символа', () => {
  const long: Candidate = { ...candidate, title: 'Я'.repeat(900), tags: Array(60).fill('тег') };
  assert.ok(buildCard(long, 'crust', []).caption.length <= 1024);
});

test('три кнопки с itemId и бакетом в callback_data', () => {
  const card = buildCard(candidate, 'crust', []);
  const buttons = card.keyboard.inline_keyboard.flat();
  assert.equal(buttons.length, 3);
  for (const button of buttons) {
    assert.ok(button.callback_data.length <= 64, 'callback_data длиннее лимита Telegram');
    assert.deepEqual(parseCallback(button.callback_data)?.itemId, 42);
  }
  assert.deepEqual(
    buttons.map((b) => parseCallback(b.callback_data)?.action),
    ['post', 'skip', 'next'],
  );
});

test('архивный кандидат объясняется соседями, свежий — датой', () => {
  const fresh = buildCard(candidate, 'crust', ['crust']);
  assert.match(fresh.caption, /01\.08\.2026|свеж/i);
  const archive = buildCard({ ...candidate, origin: 'archive', neighborWeight: 0.42 }, 'crust', []);
  assert.match(archive.caption, /сосед/i);
});

test('пост в канал не содержит служебных пометок и кнопок', () => {
  const post = buildChannelPost(candidate, ['crust']);
  assert.ok(!post.includes('callback'));
  assert.match(post, /https:\/\/label\.bandcamp\.com\/album\/a/);
});

test('битый callback_data не роняет разбор', () => {
  assert.equal(parseCallback('мусор'), null);
});

// --- Дополнительные тесты на три решения из задачи ---

test('обрезка не рвёт HTML: ни сущность, ни тег <b> не режутся пополам даже при экстремальном заголовке', () => {
  const hostile: Candidate = { ...candidate, title: '<'.repeat(2000), tags: [], label: null };
  const card = buildCard(hostile, 'crust', []);
  assert.ok(card.caption.length <= 1024);
  assert.ok(card.caption.includes(hostile.url), 'ссылка должна остаться целой');
  assert.equal((card.caption.match(/<b>/g) ?? []).length, 1, 'открывающий <b> должен быть ровно один');
  assert.equal((card.caption.match(/<\/b>/g) ?? []).length, 1, 'закрывающий </b> должен быть ровно один');
  const withoutBoldTags = card.caption.replace(/<\/?b>/g, '');
  assert.ok(!withoutBoldTags.includes('<'), 'необработанный символ < просочился мимо экранирования');
  assert.ok(
    !/&(?!amp;|lt;|gt;)/.test(card.caption),
    'найден необрубленный "&" — похоже, HTML-сущность обрезана посередине',
  );
});

test('когда огромный заголовок съедает бюджет, ссылка выживает целиком, а не обрезается', () => {
  const massiveTitle: Candidate = { ...candidate, title: 'X'.repeat(1200) };
  const card = buildCard(massiveTitle, 'crust', ['crust']);
  assert.ok(card.caption.length <= 1024);
  assert.ok(
    card.caption.endsWith(massiveTitle.url),
    'ссылка должна быть последней строкой и не обрезанной',
  );
});

test('callback_data укладывается в 64 байта в худшем случае — самый длинный бакет и максимальный itemId', () => {
  const worst = buildCard({ ...candidate, itemId: Number.MAX_SAFE_INTEGER }, 'hardcore-punk', []);
  for (const button of worst.keyboard.inline_keyboard.flat()) {
    assert.ok(
      Buffer.byteLength(button.callback_data, 'utf8') <= 64,
      `callback_data ${button.callback_data} длиннее 64 байт`,
    );
  }
});

test('когда бюджета хватает ровно на артиста, обрезается только название — не имя артиста', () => {
  // Ссылка подобрана так, что на заголовок остаётся ровно столько символов,
  // сколько занимает "<b>Band &amp; Co</b> — " (23) — граничный случай между
  // «título обрезается» и «даже артисту не хватает места».
  const url = `https://x.test/${'a'.repeat(1000 - 'https://x.test/'.length)}`;
  assert.equal(url.length, 1000);
  const c: Candidate = { ...candidate, url, title: 'Some Title' };
  const card = buildCard(c, 'crust', []);
  assert.ok(
    card.caption.startsWith('<b>Band &amp; Co</b>'),
    `имя артиста обрезалось, хотя бюджета хватало ровно на него: ${card.caption.slice(0, 40)}`,
  );
});

// --- Найдено ревью: ветка «даже артисту не хватает места» не перепроверяет
// длину после экранирования, в отличие от ветки названия. ---

test('ветка «артисту не хватает места» тоже не вылезает за лимит, даже когда экранирование раздувает текст', () => {
  // Длинный URL сжимает бюджет заголовка до значения меньше длины
  // экранированного имени артиста — это форсирует раннюю ветку в
  // buildHeader. Артист состоит из символов, которые при экранировании
  // впятеро/вчетверо раздуваются ('<' -> '&lt;', 4x), так что наивная
  // обрезка сырого текста по бюджету символов, применённая ДО
  // экранирования, даёт результат, который после экранирования снова не
  // укладывается в бюджет.
  const url = `https://x.test/${'a'.repeat(900 - 'https://x.test/'.length)}`;
  assert.equal(url.length, 900);
  const c: Candidate = { ...candidate, url, artist: '<'.repeat(300), title: 'T', tags: [], label: null };
  const card = buildCard(c, 'crust', []);
  assert.ok(
    card.caption.length <= 1024,
    `подпись длиной ${card.caption.length} превышает лимит Telegram в 1024 символа`,
  );
});

// --- Общий guard-тест по таблице агрессивных входов ---

const adversarialCases: Array<{ name: string; overrides: Partial<Candidate> }> = [
  { name: 'очень длинное название', overrides: { title: 'T'.repeat(2000) } },
  { name: 'очень длинное имя артиста', overrides: { artist: 'A'.repeat(2000) } },
  {
    name: 'экранируемые символы вперемешку в артисте и названии',
    overrides: { artist: '<<>>&&'.repeat(200), title: '&<>'.repeat(200) },
  },
  {
    name: 'эмодзи — суррогатные пары',
    overrides: { title: '🔥💀🎸'.repeat(200), artist: '🤘'.repeat(100) },
  },
  {
    name: 'RTL-текст (арабский)',
    overrides: { title: 'أبجدية عربية طويلة جدا جدا جدا '.repeat(60), artist: 'فرقة موسيقية' },
  },
  { name: 'очень длинный URL', overrides: { url: `https://x.test/${'a'.repeat(950)}` } },
  {
    name: 'очень много тегов',
    overrides: { tags: Array.from({ length: 300 }, (_, i) => `тег-${i}-<>&`) },
  },
  {
    name: 'всё сразу — длинный артист и название с экранируемыми символами, эмодзи, длинный URL, много тегов',
    overrides: {
      title: `🔥<A&B>${'x'.repeat(400)}`,
      artist: `فرقة<&>${'y'.repeat(200)}`,
      url: `https://x.test/${'z'.repeat(600)}`,
      tags: Array.from({ length: 100 }, (_, i) => `<t${i}>&`),
      label: '<Label & Co>'.repeat(50),
    },
  },
];

test('на наборе агрессивных входов подпись всегда в лимите, с парой сбалансированных <b> и без обрубленных сущностей', () => {
  for (const { name, overrides } of adversarialCases) {
    const c: Candidate = { ...candidate, ...overrides };
    const card = buildCard(c, 'crust', ['crust', 'd-beat']);

    assert.ok(
      card.caption.length <= 1024,
      `[${name}] длина подписи ${card.caption.length} > 1024`,
    );

    const opens = (card.caption.match(/<b>/g) ?? []).length;
    const closes = (card.caption.match(/<\/b>/g) ?? []).length;
    assert.equal(opens, closes, `[${name}] несбалансированные <b>/</b>: ${opens} против ${closes}`);
    assert.ok(opens <= 1, `[${name}] найдено больше одной пары <b>`);

    const withoutBoldTags = card.caption.replace(/<\/?b>/g, '');
    assert.ok(!withoutBoldTags.includes('<'), `[${name}] необработанный символ < вне <b>/</b>`);
    assert.ok(!withoutBoldTags.includes('>'), `[${name}] необработанный символ > вне <b>/</b>`);
    assert.ok(
      !/&(?!amp;|lt;|gt;)/.test(card.caption),
      `[${name}] обрубленная HTML-сущность (одинокий "&")`,
    );

    // Каждая кнопка тоже должна укладываться в лимит Telegram на callback_data.
    for (const button of card.keyboard.inline_keyboard.flat()) {
      assert.ok(
        Buffer.byteLength(button.callback_data, 'utf8') <= 64,
        `[${name}] callback_data ${button.callback_data} длиннее 64 байт`,
      );
    }
  }
});
