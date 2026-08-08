/**
 * Разовый скрипт: строит data/profile.json из живой коллекции и вишлиста
 * владельца на Bandcamp. Запускается руками, не по расписанию (см. Task 15
 * в docs/superpowers/plans/2026-08-03-bandcamp-daily.md). Результат читает
 * и правит руками владелец — дальше по нему скорятся все рекомендации,
 * поэтому скрипт печатает по каждому бакету, на чём именно он построен,
 * а не только финальные веса.
 *
 * Дорого: коллекция + вишлист владельца — это около 720 страниц релизов
 * (по одной на релиз, кэшируются на диск навсегда), плюс сэмплирование
 * тег-хабов на антипрофиль. Холодный прогон — 20-40 минут при паузе
 * между запросами. Повторный прогон почти мгновенный за счёт кэша в
 * .cache/, если сами страницы релизов не менялись.
 */
import { access } from 'node:fs/promises';
import { Http } from '../src/lib/http.ts';
import { readJson, writeJson } from '../src/lib/state.ts';
import { fetchAlbum } from '../src/bandcamp/album.ts';
import { fetchFanItems } from '../src/bandcamp/fan.ts';
import { discover } from '../src/bandcamp/discover.ts';
import { BUCKETS, bucketsOf, hubSampleTags } from '../src/profile/buckets.ts';
import { buildProfile, type Profile, type ProfileInput } from '../src/profile/build.ts';
import { deriveStopTagsForBucket, type HubStopTagSample } from '../src/profile/stop-tags.ts';
import {
  buildLocationVocabulary,
  type LocationSample,
  type LocationVocabularyFile,
} from '../src/profile/locations.ts';
import type { BucketId } from '../src/bandcamp/types.ts';

const OWNER_FAN_ID = 7566215;
/** Сколько релизов тег-хаба запрашивать на один хаб-тег. */
const HUB_SAMPLE_SIZE = 60;
/**
 * Сколько seed-тегов бакета используется как хаб-теги для антипрофиля —
 * см. `hubSampleTags` в `src/profile/buckets.ts`. Раньше здесь были не
 * seed-, а самые тяжёлые ДЕРИВИРОВАННЫЕ теги бакета — и живой прогон
 * (2026-08) показал цену: для hardcore-punk и crust это оказался голый
 * 'punk' (хаб — 470000 релизов), для death-metal — 'metal' (496000), а
 * иногда деривированный топ вообще вытягивал тег города. Сэмпл 60 из
 * хаба такого размера или из городского хаба описывает Bandcamp вообще
 * или конкретный город, а не жанр по соседству — этим и объясняются
 * пустые стоп-листы во всех трёх бакетах на живом прогоне. Seed-теги —
 * рукописный, стабильный между прогонами список жанровых маркеров, а
 * hubSampleTags внутри ещё и предпочитает среди них составные
 * (специфичные) голым однословным, так что тот же голый 'punk'/'hardcore'
 * в хаб-сэмплирование не пройдёт, даже после того как их вернули в
 * seedTags бакета hardcore-punk по решению хозяина.
 */
const HUB_TAGS_PER_BUCKET = 3;
/** Ниже этого числа релизов бакет считается слишком тонким — предупреждение в вывод. */
const MIN_RELEASES_WARN = 10;
/** Ниже этого числа выживших тегов бакет считается слишком тонким — предупреждение в вывод. */
const MIN_TAGS_WARN = 5;

const PROFILE_PATH = 'data/profile.json';
const LOCATION_VOCAB_PATH = 'data/location-vocabulary.json';

/**
 * Профиль правится руками, и правки — это единственная вкусовая настройка во
 * всей системе. Молча затереть их пересборкой недопустимо, поэтому перезапись
 * требует явного `--force`, а не просто повторного запуска скрипта. Прогон
 * без него отменяется целиком ДО сети — иначе 20-40 минут запросов ушли бы
 * впустую на результат, который всё равно нельзя сохранить.
 */
async function assertWritable(path: string): Promise<void> {
  if (process.argv.includes('--force')) return;
  try {
    await access(path);
  } catch {
    return;
  }
  console.error(
    `${path} уже существует. Пересборка затрёт правки, внесённые руками.\n` +
      'Если это то, что нужно: сохрани текущий файл где-нибудь и запусти с флагом --force.',
  );
  process.exit(1);
}

await assertWritable(PROFILE_PATH);

const http = new Http({ cacheDir: '.cache', minDelayMs: 900 });

console.log(`Читаю коллекцию и вишлист фана ${OWNER_FAN_ID}...`);
const collection = await fetchFanItems(http, OWNER_FAN_ID, 'collection');
const wishlist = await fetchFanItems(http, OWNER_FAN_ID, 'wishlist');
console.log(
  `Коллекция: ${collection.length}, вишлист: ${wishlist.length}, всего релизов: ${
    collection.length + wishlist.length
  }`,
);

const fanItems = [...collection, ...wishlist];

console.log('Читаю страницы релизов (первый раз долго, дальше — из дискового кэша .cache/)...');
const CROSSWALK_PATH = 'data/spotify-crosswalk.json';
const inputs: ProfileInput[] = [];
/**
 * Тег → на скольких релизах коллекции+вишлиста встретился — вход для
 * порога владения в deriveStopTags (см. комментарий у `ownedTagCounts` в
 * stop-tags.ts: раньше здесь было множество, и единственное вхождение
 * иммунизировало тег навсегда, из-за чего стоп-листы были пустыми везде).
 */
const ownedTagCounts: Record<string, number> = {};
let unreadable = 0;

for (const [index, item] of fanItems.entries()) {
  const album = await fetchAlbum(http, item.url);
  if (!album) {
    unreadable += 1;
    continue;
  }
  for (const tag of new Set(album.tags)) {
    ownedTagCounts[tag] = (ownedTagCounts[tag] ?? 0) + 1;
  }
  inputs.push({
    tags: album.tags,
    label: album.label,
    addedAt: item.addedAt,
    source: item.source,
  });
  const done = index + 1;
  if (done % 50 === 0 || done === fanItems.length) {
    console.log(`  ${done}/${fanItems.length} страниц релизов прочитано (не читается: ${unreadable})`);
  }
}

console.log(
  `Страницы релизов прочитаны: ${inputs.length} успешно, ${unreadable} пропущено (страница недоступна или не разобралась).`,
);

// Антипрофиль (hubTagCounts на стоп-теги) и словарь мест (locationVocabulary
// на веса тегов) харвестятся ОДНИМ и тем же проходом по тег-хабам Discover —
// band_location едет в том же ответе, за который и так уже платим сетевым
// запросом ради подсчёта тегов хаба, см. комментарий у DiscoverItem.location.
// Поэтому этот проход идёт ДО buildProfile: словарь мест нужен buildProfile
// на входе (см. locationVocabulary в BuildOptions), а не пристёгивается
// постфактум.
console.log('\nСобираю антипрофиль из тег-хабов Discover (для стоп-тегов и словаря мест)...');
/**
 * Бакет → по одному сэмплу на каждый хаб-тег (НЕ пул счётчиков всех хабов
 * бакета в одну запись). Раньше здесь была одна пара {hubTagCounts,
 * releasesSampled} на весь бакет, все 3 хаба схлопывались в неё вместе — и
 * именно это делало стоп-теги пустыми на живом прогоне (см. комментарий у
 * `deriveStopTagsForBucket` в stop-tags.ts, разбор арифметики в отчёте по
 * задаче). Каждый хаб теперь считается и передаётся дальше по отдельности.
 */
const bucketHubData = new Map<BucketId, HubStopTagSample[]>();
const locationSamples: LocationSample[] = [];

for (const bucket of BUCKETS) {
  const hubTags = hubSampleTags(bucket, HUB_TAGS_PER_BUCKET);
  const hubs: HubStopTagSample[] = [];

  for (const tag of hubTags) {
    const hubTagCounts: Record<string, number> = {};
    let releasesSampled = 0;
    const hubItems = await discover(http, { tag, slice: 'top', size: HUB_SAMPLE_SIZE });
    for (const hubItem of hubItems) {
      locationSamples.push({ location: hubItem.location, artist: hubItem.artist });
      const album = await fetchAlbum(http, hubItem.url);
      if (!album) continue;
      releasesSampled += 1;
      for (const albumTag of album.tags) {
        hubTagCounts[albumTag] = (hubTagCounts[albumTag] ?? 0) + 1;
      }
    }
    hubs.push({ hubTagCounts, releasesSampled });
  }

  bucketHubData.set(bucket.id, hubs);
  const totalReleasesSampled = hubs.reduce((sum, hub) => sum + hub.releasesSampled, 0);
  console.log(`  ${bucket.title}: хаб-теги [${hubTags.join(', ')}], сэмплировано релизов хаба: ${totalReleasesSampled}`);
}

/**
 * Словарь мест правится руками так же, как profile.json (см. assertWritable
 * выше) — но мягче: если файл уже есть и --force не передан, прогон не
 * прерывается целиком (словарь — вспомогательный вход, а не терминальный
 * результат), а просто читает и использует сохранённую версию, оставляя
 * ручные правки владельца нетронутыми. Свежесобранный вариант при этом
 * не выбрасывается молча — его размер печатается рядом, чтобы было видно,
 * разошлись ли харвест этого прогона и сохранённый файл.
 */
const harvestedLocations = buildLocationVocabulary(locationSamples);
const existingVocabFile = await readJson<LocationVocabularyFile | null>(LOCATION_VOCAB_PATH, null);
// Отдельный флаг, а не общий --force: профиль пересобирается часто (меняются
// правила весов), а словарь мест — редко, и правки в нём делаются руками, для
// городов, которых не оказалось в хабах. Одна ручка на два артефакта означала
// бы, что любая пересборка профиля молча стирает ручные добавления в словарь.
const forceVocabRewrite = process.argv.includes('--force-locations');

let locationVocabulary: Set<string>;
if (existingVocabFile && !forceVocabRewrite) {
  locationVocabulary = new Set(existingVocabFile.locations);
  console.log(
    `\nСловарь мест: использую сохранённый ${LOCATION_VOCAB_PATH} (${existingVocabFile.locations.length} записей, ` +
      `от ${existingVocabFile.generatedAt}). Свежий харвест этого прогона дал бы ${harvestedLocations.length} записей — ` +
      `если разброс большой, пересобери файл через --force и сверь его руками.`,
  );
} else {
  locationVocabulary = new Set(harvestedLocations);
  const vocabFile: LocationVocabularyFile = {
    generatedAt: new Date().toISOString().slice(0, 10),
    samplesHarvested: locationSamples.length,
    minDistinctArtists: 2,
    locations: harvestedLocations,
  };
  await writeJson(LOCATION_VOCAB_PATH, vocabFile);
  console.log(
    `\nСловарь мест: собрал заново из ${locationSamples.length} сэмплов band_location, ` +
      `${harvestedLocations.length} записей, записал в ${LOCATION_VOCAB_PATH}. Просмотри файл руками — ` +
      'это единственная защита от ложных срабатываний (город, который по совпадению значит что-то ещё).',
  );
}

// Артисты из Spotify, разрешённые на Bandcamp ради их тегов
// (`bin/spotify-crosswalk.ts`). Единственный источник вкуса для бакета
// электроники: покупок в этом жанре у владельца нет ни одной, а слушает он
// его наравне с панком. Каждый артист входит как один псевдо-релиз со своими
// тегами — дальше буквально та же машинерия, что и для покупок:
// перепредставленность тега, порог minReleases, вычитание географии,
// стоп-теги. Никаких исключений в логике профиля ради этого источника нет.
//
// Файла может не быть (кросволк не прогоняли) — это не повод падать: профиль
// соберётся по одному Bandcamp, просто бакет электроники останется пустым.
const crosswalk = await readJson<{
  tags?: { tag: string; weight: number; artists: string[] }[];
  matchedOnBandcamp?: number;
} | null>(CROSSWALK_PATH, null);

if (crosswalk?.tags?.length) {
  // Обратная развёртка: в файле теги → артисты, а профилю нужны релизы с
  // тегами. Собираем по артисту его набор тегов и вес.
  const tagsByArtist = new Map<string, { tags: string[]; weight: number }>();
  for (const entry of crosswalk.tags) {
    for (const artist of entry.artists) {
      const existing = tagsByArtist.get(artist) ?? { tags: [], weight: 0 };
      existing.tags.push(entry.tag);
      existing.weight = Math.max(existing.weight, entry.weight);
      tagsByArtist.set(artist, existing);
    }
  }
  for (const [, artist] of tagsByArtist) {
    inputs.push({
      tags: artist.tags,
      label: null,
      addedAt: new Date().toISOString().slice(0, 10),
      source: 'spotify',
      // Вес тега нормирован к 1 у самого частого; поднимаем пол до 0.3, иначе
      // длинный хвост артистов с одним тегом входил бы почти нулевым весом и
      // не влиял бы ни на что, ради чего его и тянули.
      weight: Math.max(artist.weight, 0.3),
    });
  }
  console.log(
    `\nSpotify: добавил ${tagsByArtist.size} артистов как псевдо-релизы ` +
      `(из ${crosswalk.matchedOnBandcamp ?? '?'} найденных на Bandcamp).`,
  );
} else {
  console.log('\nSpotify: data/spotify-crosswalk.json нет или он пуст — бакет электроники останется пустым.');
}

const profile = buildProfile(inputs, { now: new Date(), minReleases: 2, locationVocabulary });

console.log('\nСтоп-теги по бакетам...');
for (const bucket of BUCKETS) {
  // minHubShare/minHubCount/minOwnedCount умышленно не переданы — берём
  // дефолты deriveStopTags (0.2 доли, пол 5, владение с 2 вхождений), они не
  // менялись. locationVocabulary передан явно — тот же словарь, который
  // buildProfile уже применяет к весам бакета (см. вызов выше), теперь режет
  // и стоп-теги: без него тег места ('amadora' — город в Португалии) хаб-
  // частый и невладеемый ровно так же, как настоящий соседний поджанр, и
  // штрафовал бы каждый релиз из этого города вне зависимости от жанра.
  //
  // Пустые стоп-листы живого прогона (2026-08) были следствием ТРЁХ
  // независимых причин, а не двух: мусорного ВХОДА хабов (чинит
  // hubSampleTags, уже сделано), слишком мягкого теста владения (чинит
  // minOwnedCount, отдельный коммит) — и порога частоты, который считался по
  // ПУЛУ из трёх хабов (180 сэмплов, порог 36) вместо каждого хаба по
  // отдельности (60 сэмплов, порог 12). Тег, характерный ровно для одного из
  // трёх хабов, физически не мог набрать больше своего потолка в 60 из пула
  // 180 — проходили только широкие зонтичные теги ('metal', 'death metal'),
  // которые и так вырезает проверка владения, а не узкие соседние поджанры,
  // которым и полагалось стать стоп-тегами. deriveStopTagsForBucket (см.
  // stop-tags.ts) судит каждый хаб бакета своим порогом и объединяет
  // результаты — подробный разбор арифметики в отчёте по задаче.
  profile.buckets[bucket.id].stopTags = deriveStopTagsForBucket({
    hubs: bucketHubData.get(bucket.id)!,
    ownedTagCounts,
    seedTags: bucket.seedTags,
    locationVocabulary,
  });

  console.log(
    `  ${bucket.title}: стоп-тегов найдено: ${profile.buckets[bucket.id].stopTags.length}`,
  );
}

// hardRejectTags (см. `Profile.hardRejectTags` в `../src/profile/build.ts`)
// — чисто ручная настройка хозяина, без источника в данных: в отличие от
// stopTags выше, для неё нет deriveStopTagsForBucket, который пересчитал бы
// список заново на каждой пересборке. buildProfile() честно вернула для
// него пустой список (у неё нет входа, из которого его вывести) — если
// записать профиль как есть, пересборка (даже штатная, с --force и
// осознанным согласием на потерю правок весов — см. `assertWritable` выше)
// молча стёрла бы список компиляций, который хозяин завёл руками, и защита
// исчезла бы без единого предупреждения в выводе скрипта. Переносим
// значение из уже существующего файла вперёд; если файла ещё не было
// (самая первая сборка) — пустой список, как и вернула buildProfile.
const existingProfile = await readJson<Profile | null>(PROFILE_PATH, null);
profile.hardRejectTags = existingProfile?.hardRejectTags ?? [];
console.log(
  `\nhardRejectTags: перенесено из существующего файла — ${profile.hardRejectTags.length} тег(ов): ` +
    `${profile.hardRejectTags.join(', ') || '(пусто)'}.`,
);

await writeJson(PROFILE_PATH, profile);

console.log('\n=== Итог по бакетам ===');
for (const bucket of BUCKETS) {
  const data = profile.buckets[bucket.id];
  const tagCount = Object.keys(data.tags).length;
  const top = Object.entries(data.tags)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([tag, weight]) => `${tag} ${weight}`)
    .join(', ');

  console.log(`\n${bucket.title} (${bucket.id})`);
  console.log(`  релизов, питавших бакет: ${data.releaseCount}`);
  console.log(`  тегов пережило порог (minReleases=2): ${tagCount}`);
  console.log(`  топ-теги: ${top || '(пусто)'}`);
  console.log(`  стоп-теги: ${data.stopTags.slice(0, 12).join(', ') || '(пусто)'}`);

  if (data.releaseCount < MIN_RELEASES_WARN) {
    console.warn(
      `  ПРЕДУПРЕЖДЕНИЕ: у бакета "${bucket.id}" всего ${data.releaseCount} релизов (порог ${MIN_RELEASES_WARN}). ` +
        'Профиль ненадёжен — скорер будет часто отбраковывать всё подряд. ' +
        'Что делать: расширить seedTags бакета в src/profile/buckets.ts (если в коллекции релизы жанра ' +
        'есть, но тегированы иначе), либо руками дописать теги и веса прямо в data/profile.json.',
    );
  }
  if (tagCount < MIN_TAGS_WARN) {
    console.warn(
      `  ПРЕДУПРЕЖДЕНИЕ: у бакета "${bucket.id}" всего ${tagCount} тегов пережили порог совпадения. ` +
        'Что делать: добавить теги руками в data/profile.json (файл для этого и существует — веса 0..1, ' +
        'опорный тег держит 0.5) или снизить minReleases в вызове buildProfile при следующей пересборке.',
    );
  }
}

const unbucketed = inputs.filter((item) => bucketsOf(item.tags).length === 0).length;
console.log(`\nРелизов вне всех бакетов: ${unbucketed} из ${inputs.length} прочитанных.`);
console.log(`Релизов пропущено из-за нечитаемой страницы: ${unreadable} из ${fanItems.length}.`);
console.log(`\nПрофиль записан в ${PROFILE_PATH}. Правь tags и stopTags прямо в файле —`);
console.log('повторный запуск без --force его не тронет, чтобы правки не потерялись.');
console.log(
  `Словарь мест — в ${LOCATION_VOCAB_PATH}; пересобрать его заново можно только флагом --force-locations, ` +
    'обычная пересборка профиля ручные правки в нём не трогает.',
);
