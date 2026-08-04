import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candidate } from '../bandcamp/types.ts';
import { BUCKETS } from '../profile/buckets.ts';
import { buildCard, buildChannelPost, parseCallback } from './card.ts';

const CAPTION_LIMIT = 1024;

/** Дублирует escapeHtml из card.ts — тестам нужно предсказывать длину без импорта приватностей. */
function escapeForTest(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
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

/** Веса бакета для buildChannelPost — оба сырых тега фикстуры признаны жанровыми (см. buildChannelPost.test.ts ниже про фильтр по весам). */
const bucketTags: Record<string, number> = { crust: 0.5, 'd-beat': 0.5 };

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
  const post = buildChannelPost(candidate, bucketTags);
  assert.ok(!post.includes('callback'));
  // Ссылка теперь живёт в href заголовка, а не отдельной строкой — сама
  // подстрока URL по-прежнему присутствует в тексте (внутри атрибута).
  assert.match(post, /https:\/\/label\.bandcamp\.com\/album\/a/);
});

test('пост в канал не содержит объяснения рекомендателя — ни для свежего, ни для архивного кандидата', () => {
  const freshPost = buildChannelPost(candidate, bucketTags);
  assert.ok(!/совпало/i.test(freshPost), 'пост в канал содержит "совпало" — это для владельца, не подписчиков');
  assert.ok(!/свежее/i.test(freshPost), 'пост в канал содержит пометку "свежее" — это объяснение для владельца');

  const archivePost = buildChannelPost({ ...candidate, origin: 'archive', neighborWeight: 0.42 }, bucketTags);
  assert.ok(!/сосед/i.test(archivePost), 'пост в канал упоминает соседей по вкусу — внутренняя кухня рекомендателя');
  assert.ok(!/близость/i.test(archivePost), 'пост в канал содержит процент близости к соседям');
});

test('теги в посте в канал — хэштеги, а не плоский список через точку', () => {
  const post = buildChannelPost(candidate, bucketTags);
  assert.match(post, /#crust/);
  // 'd-beat' взвешен в bucketTags — превращается в '#dbeat' (пробел/дефис
  // вырезает canonicalizeTag, см. пример в задаче: 'd-beat' → '#dbeat').
  assert.match(post, /#dbeat/);
  assert.ok(!post.includes(' · '), 'старый плоский разделитель тегов не должен остаться в посте канала');
  assert.ok(!post.includes('d-beat'), 'сырое написание тега не должно просочиться мимо хэштег-трансформации');
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
  const post = buildChannelPost(candidate, bucketTags);
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

// --- Задача: хозяин попросил поменять формат поста в канал после первого
// реального поста — ссылка в хедере, жанры хэштегами, без строки лейбла. ---

/**
 * Реальный первый пост, из-за которого хозяин попросил формат поменять:
 * ELECTRIC CHAIR / PHYSIQUE — Split (LUNGS-277), лейбл IRON LUNG Records.
 * Сырые теги релиза как они пришли с Bandcamp — вперемешку город
 * ('olympia'), настоящие жанры ('punk', 'crust', 'hardcore') и явный мусор
 * ('energy', 'friendship', 'greatest label of all time', 'iron lung' — имя
 * самого лейбла как тег).
 */
const realExampleCandidate: Candidate = {
  itemId: 987654321,
  url: 'https://ironlungrecords.bandcamp.com/album/split-lungs-277',
  title: 'Split (LUNGS-277)',
  artist: 'ELECTRIC CHAIR / PHYSIQUE',
  label: 'IRON LUNG Records',
  tags: ['olympia', 'punk', 'crust', 'energy', 'friendship', 'greatest label of all time', 'hardcore', 'iron lung'],
  releasedAt: '2026-08-01',
  artUrl: 'https://f4.bcbits.com/img/a1_10.jpg',
  alsoCollected: 0,
  origin: 'fresh',
};

/**
 * Веса бакета 'crust', как их реально насчитал бы `buildProfile`
 * (`../profile/build.ts`) для коллекции хозяина: только то, что
 * статистически характерно для бакета. Ни города ('olympia' — вычитается
 * словарём мест структурно, ещё до статистики), ни вкусовых/маркетинговых
 * слов с этого конкретного релиза ('energy', 'friendship', 'greatest label
 * of all time', 'iron lung') среди ключей нет — они никогда не оказываются
 * статистически характерны для жанрового бакета, потому что не являются
 * жанром ни у одного другого релиза коллекции.
 */
const crustBucketTags: Record<string, number> = { crust: 0.5, punk: 0.3179, hardcore: 0.1163 };

test('реальный пример из задачи: хэштеги в посте — только жанровые теги бакета, без города и мусора', () => {
  const post = buildChannelPost(realExampleCandidate, crustBucketTags);

  // Единственная строка тегов — хэштеги трёх жанровых тегов, по убыванию веса.
  assert.match(post, /^#crust #punk #hardcore$/m);

  // Город и явный мусор с релиза не должны просочиться ни в каком виде.
  for (const junk of ['olympia', 'energy', 'friendship', 'greatest label of all time', 'iron lung']) {
    assert.ok(!post.toLowerCase().includes(junk), `в посте канала не должно быть "${junk}"`);
  }

  // Лейбла в посте канала нет вовсе — хозяин прямо попросил его убрать.
  assert.ok(!/лейбл/i.test(post), 'пост в канал не должен содержать строку лейбла');
  assert.ok(!post.includes('IRON LUNG Records'), 'название лейбла не должно остаться текстом в посте канала');

  // Заголовок — ссылка на релиз, и текст заголовка не изменился по смыслу.
  assert.match(
    post,
    /^<a href="https:\/\/ironlungrecords\.bandcamp\.com\/album\/split-lungs-277"><b>ELECTRIC CHAIR \/ PHYSIQUE<\/b> — Split \(LUNGS-277\)<\/a>$/m,
  );
});

test('реальный пример: карточка владельца сохраняет лейбл и полный список тегов (не хэштеги)', () => {
  const card = buildCard(realExampleCandidate, 'crust', []);
  assert.match(card.caption, /лейбл: IRON LUNG Records/);
  assert.match(
    card.caption,
    /olympia · punk · crust · energy · friendship · greatest label of all time · hardcore · iron lung/,
  );
  // Заголовок владельца остаётся жирным текстом, а не ссылкой — карточка
  // уходит фото-сообщением (sendPhoto), у которого нет автопревью по ссылке.
  assert.match(card.caption, /^<b>ELECTRIC CHAIR \/ PHYSIQUE<\/b> — Split \(LUNGS-277\)$/m);
  assert.ok(!card.caption.includes('<a href='), 'заголовок карточки владельца не должен становиться ссылкой');
});

test('заголовок поста в канал — HTML-ссылка на candidate.url целиком, без обрезки', () => {
  const post = buildChannelPost(candidate, bucketTags);
  assert.match(post, new RegExp(`^<a href="${candidate.url.replace(/[/.]/g, '\\$&')}">`));
  assert.ok(!post.includes(candidate.url + '\n'), 'голой строки URL под текстом больше быть не должно');
  // В посте ровно одна ссылка (заголовок), а не голая ссылка ещё и отдельной строкой.
  assert.equal((post.match(/https:\/\/label\.bandcamp\.com\/album\/a/g) ?? []).length, 1);
});

test('хэштегов не больше пяти даже когда бакет взвешивает много тегов кандидата разом (шумный хвост)', () => {
  const manyTags = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const weights = Object.fromEntries(manyTags.map((tag, i) => [tag, 1 - i * 0.1]));
  const post = buildChannelPost({ ...candidate, tags: manyTags }, weights);
  // Заголовок (первая строка) ссылка на url и хэштегов не несёт — искать
  // можно по всему посту, совпадение будет ровно там, где строка хэштегов.
  const hashtags = post.match(/#\w+/g) ?? [];
  assert.equal(hashtags.length, 5, 'хэштегов должно быть не больше 5 (HASHTAG_CAP)');
  assert.deepEqual(hashtags, ['#a', '#b', '#c', '#d', '#e'], 'должны выжить пять с наибольшим весом, по убыванию');
});

test('хэштег вычищает пунктуацию, которую Telegram не примет частью тега, и отбрасывает тег, начинающийся с цифры', () => {
  const post = buildChannelPost(
    { ...candidate, tags: ['r&b', '2-step', 'crust punk'] },
    { 'r&b': 0.9, '2-step': 0.8, 'crust punk': 0.7 },
  );
  assert.match(post, /#rb\b/, '"r&b" должен стать "#rb" — амперсанд хэштег нести не может');
  assert.ok(!/#2/.test(post), '"2-step" не должен попасть в хэштеги — начинается с цифры');
  assert.match(post, /#crustpunk\b/, '"crust punk" схлопывается в "#crustpunk" через ту же canonicalizeTag');
});

test('если после фильтра по весам бакета не осталось жанровых тегов, строка хэштегов не печатается вовсе', () => {
  const post = buildChannelPost({ ...candidate, tags: ['olympia', 'friendship'] }, { crust: 0.5 });
  assert.ok(!post.includes('#'), 'не должно остаться ни одного хэштега');
  assert.ok(!/\n\n/.test(post), 'не должно остаться пустой строки на месте пропущенных хэштегов');
});

test('на наборе агрессивных входов пост в канал остаётся в лимите 1024, с одной парой <a> и одной <b> и без обрубленных сущностей', () => {
  for (const { name, overrides } of adversarialCases) {
    const c: Candidate = { ...candidate, ...overrides };
    const post = buildChannelPost(c, { crust: 0.9, 'd-beat': 0.8 });

    assert.ok(post.length <= CAPTION_LIMIT, `[${name}] длина поста ${post.length} > ${CAPTION_LIMIT}`);

    const aOpens = (post.match(/<a href="/g) ?? []).length;
    const aCloses = (post.match(/<\/a>/g) ?? []).length;
    assert.equal(aOpens, aCloses, `[${name}] несбалансированные <a>/</a>: ${aOpens} против ${aCloses}`);
    assert.ok(aOpens <= 1, `[${name}] найдено больше одной пары <a>`);

    const bOpens = (post.match(/<b>/g) ?? []).length;
    const bCloses = (post.match(/<\/b>/g) ?? []).length;
    assert.equal(bOpens, bCloses, `[${name}] несбалансированные <b>/</b>: ${bOpens} против ${bCloses}`);
    assert.ok(bOpens <= 1, `[${name}] найдено больше одной пары <b>`);

    const withoutTags = post.replace(/<\/?a(?: href="[^"]*")?>/g, '').replace(/<\/?b>/g, '');
    assert.ok(!withoutTags.includes('<'), `[${name}] необработанный символ < вне <a>/<b>`);
    assert.ok(!withoutTags.includes('>'), `[${name}] необработанный символ > вне <a>/<b>`);
    assert.ok(
      !/&(?!amp;|lt;|gt;|quot;)/.test(post),
      `[${name}] обрубленная HTML-сущность (одинокий "&")`,
    );
  }
});

test('URL с кавычкой не ломает атрибут href — кавычка экранируется в &quot;', () => {
  const withQuote: Candidate = { ...candidate, url: 'https://x.test/album/a"><script>x</script>' };
  const post = buildChannelPost(withQuote, bucketTags);
  assert.ok(!post.includes('"><script>'), 'неэкранированная кавычка вырвалась бы из атрибута href');
  assert.match(post, /&quot;&gt;&lt;script&gt;/);
  assert.ok(post.startsWith('<a href="https://x.test/album/a&quot;&gt;&lt;script&gt;x&lt;/script&gt;">'));
});
