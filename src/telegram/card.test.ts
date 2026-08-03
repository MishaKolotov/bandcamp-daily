import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candidate } from '../bandcamp/types.ts';
import { BUCKETS } from '../profile/buckets.ts';
import { buildCard, buildChannelPost, parseCallback } from './card.ts';

const CAPTION_LIMIT = 1024;

/** Дублирует escapeHtml из card.ts — тестам нужно предсказывать длину без импорта приватностей. */
function escapeForTest(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

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
  const post = buildChannelPost(candidate);
  assert.ok(!post.includes('callback'));
  assert.match(post, /https:\/\/label\.bandcamp\.com\/album\/a/);
});

test('пост в канал не содержит объяснения рекомендателя — ни для свежего, ни для архивного кандидата', () => {
  const freshPost = buildChannelPost(candidate);
  assert.ok(!/совпало/i.test(freshPost), 'пост в канал содержит "совпало" — это для владельца, не подписчиков');
  assert.ok(!/свежее/i.test(freshPost), 'пост в канал содержит пометку "свежее" — это объяснение для владельца');

  const archivePost = buildChannelPost({ ...candidate, origin: 'archive', neighborWeight: 0.42 });
  assert.ok(!/сосед/i.test(archivePost), 'пост в канал упоминает соседей по вкусу — внутренняя кухня рекомендателя');
  assert.ok(!/близость/i.test(archivePost), 'пост в канал содержит процент близости к соседям');
});

test('плоская строка тегов в посте в канал остаётся — это просто информация о жанре', () => {
  const post = buildChannelPost(candidate);
  assert.match(post, /crust/);
  assert.match(post, /d-beat/);
});

test('карточка владельца показывает название канала — иначе не понять, куда уйдёт кнопка «В канал» среди четырёх', () => {
  for (const bucket of BUCKETS) {
    const card = buildCard(candidate, bucket.id, []);
    assert.ok(
      card.caption.includes(bucket.channelTitle),
      `не нашли "${bucket.channelTitle}" в карточке владельца для бакета ${bucket.id}`,
    );
  }
});

test('пост в канал не содержит названия канала — подписчики и так знают, где они подписаны', () => {
  const post = buildChannelPost(candidate);
  for (const bucket of BUCKETS) {
    assert.ok(
      !post.includes(bucket.channelTitle),
      `пост в канал не должен содержать "${bucket.channelTitle}"`,
    );
  }
});

test('URL экранируется — необработанный "&" в ссылке из коллекции фаната не должен ронять HTML-подпись', () => {
  const withQuery: Candidate = { ...candidate, url: 'https://label.bandcamp.com/album/a?utm_source=x&utm_medium=y' };
  const card = buildCard(withQuery, 'crust', []);
  assert.ok(
    !/&(?!amp;|lt;|gt;)/.test(card.caption),
    'необработанный "&" из URL проскочил в подпись — Telegram отклонит такое сообщение целиком',
  );
  assert.match(card.caption, /utm_source=x&amp;utm_medium=y/);
});

test('название тегов не повторяется дважды — только в строке тегов, без повтора в объяснении', () => {
  const card = buildCard(candidate, 'crust', ['crust', 'd-beat']);
  assert.ok(!/совпало/i.test(card.caption), 'объяснение всё ещё повторяет совпавшие теги отдельной фразой');
  const occurrences = (card.caption.match(/d-beat/gi) ?? []).length;
  assert.equal(
    occurrences,
    1,
    `тег "d-beat" встречается в подписи ${occurrences} раз(а) вместо одного — читается дважды`,
  );
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

test('callback_data укладывается в 64 байта в худшем случае — самый длинный бакет (из BUCKETS, не захардкоженный) и максимальный itemId', () => {
  // Не хардкодим 'hardcore-punk': список бакетов уже расширялся один раз
  // (добавился 'black-metal'), и если когда-нибудь появится id длиннее
  // нынешнего максимума, этот тест должен сам его подхватить и споткнуться,
  // а не молча проверять устаревшее предположение.
  const longestBucket = [...BUCKETS].sort((a, b) => b.id.length - a.id.length)[0]!.id;
  const worst = buildCard({ ...candidate, itemId: Number.MAX_SAFE_INTEGER }, longestBucket, []);
  for (const button of worst.keyboard.inline_keyboard.flat()) {
    assert.ok(
      Buffer.byteLength(button.callback_data, 'utf8') <= 64,
      `callback_data ${button.callback_data} длиннее 64 байт`,
    );
  }
});

test('bucket, зашитый в callback_data, всегда возвращается тем же самым при разборе — для каждого бакета', () => {
  for (const bucket of BUCKETS) {
    const card = buildCard(candidate, bucket.id, []);
    for (const button of card.keyboard.inline_keyboard.flat()) {
      const parsed = parseCallback(button.callback_data);
      assert.equal(parsed?.bucket, bucket.id, `бакет не пережил round-trip для ${bucket.id}`);
    }
  }
});

test('когда бюджета хватает ровно на артиста, обрезается только название — не имя артиста', () => {
  // Ссылка подобрана так, что на заголовок остаётся ровно столько символов,
  // сколько занимает "<b>Band &amp; Co</b> — " — граничный случай между
  // «title обрезается» и «даже артисту не хватает места». Бюджет заголовка
  // считается уже за вычетом строки с названием канала, которую buildCard
  // теперь всегда добавляет владельцу — длину канала берём из BUCKETS, а не
  // угадываем числом.
  const crustChannelTitle = BUCKETS.find((b) => b.id === 'crust')!.channelTitle;
  const channelReserve = escapeForTest(crustChannelTitle).length + 1;
  const prefix = `<b>${escapeForTest(candidate.artist)}</b> — `;
  const domain = 'https://x.test/';
  const urlLen = CAPTION_LIMIT - 1 - channelReserve - prefix.length;
  const url = `${domain}${'a'.repeat(Math.max(urlLen - domain.length, 0))}`;
  assert.equal(url.length, urlLen);
  const c: Candidate = { ...candidate, url, title: 'Some Title' };
  const card = buildCard(c, 'crust', []);
  assert.ok(
    card.caption.includes(`<b>${escapeForTest(candidate.artist)}</b>`),
    `имя артиста обрезалось, хотя бюджета хватало ровно на него: ${card.caption}`,
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
