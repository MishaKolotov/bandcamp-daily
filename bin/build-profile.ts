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
import { writeJson } from '../src/lib/state.ts';
import { fetchAlbum } from '../src/bandcamp/album.ts';
import { fetchFanItems } from '../src/bandcamp/fan.ts';
import { discover } from '../src/bandcamp/discover.ts';
import { BUCKETS, bucketsOf } from '../src/profile/buckets.ts';
import { buildProfile, type ProfileInput } from '../src/profile/build.ts';
import { deriveStopTags } from '../src/profile/stop-tags.ts';

const OWNER_FAN_ID = 7566215;
/** Сколько релизов тег-хаба запрашивать на один хаб-тег. */
const HUB_SAMPLE_SIZE = 60;
/** Сколько самых характерных тегов бакета используется как хаб-теги для антипрофиля. */
const HUB_TAGS_PER_BUCKET = 3;
/** Ниже этого числа релизов бакет считается слишком тонким — предупреждение в вывод. */
const MIN_RELEASES_WARN = 10;
/** Ниже этого числа выживших тегов бакет считается слишком тонким — предупреждение в вывод. */
const MIN_TAGS_WARN = 5;

const PROFILE_PATH = 'data/profile.json';

/**
 * Профиль правится руками, и правки — это единственная вкусовая настройка во
 * всей системе. Молча затереть их пересборкой недопустимо, поэтому перезапись
 * требует явного `--force`, а не просто повторного запуска скрипта.
 */
async function assertWritable(): Promise<void> {
  if (process.argv.includes('--force')) return;
  try {
    await access(PROFILE_PATH);
  } catch {
    return;
  }
  console.error(
    `${PROFILE_PATH} уже существует. Пересборка затрёт правки, внесённые руками.\n` +
      'Если это то, что нужно: сохрани текущий файл где-нибудь и запусти с флагом --force.',
  );
  process.exit(1);
}

await assertWritable();

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
const inputs: ProfileInput[] = [];
const ownedTags = new Set<string>();
let unreadable = 0;

for (const [index, item] of fanItems.entries()) {
  const album = await fetchAlbum(http, item.url);
  if (!album) {
    unreadable += 1;
    continue;
  }
  for (const tag of album.tags) ownedTags.add(tag);
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

const profile = buildProfile(inputs, { now: new Date(), minReleases: 2 });

console.log('\nСобираю антипрофиль из тег-хабов Discover (для стоп-тегов)...');
for (const bucket of BUCKETS) {
  const hubTagCounts: Record<string, number> = {};
  const topBucketTags = Object.entries(profile.buckets[bucket.id].tags)
    .sort((a, b) => b[1] - a[1])
    .slice(0, HUB_TAGS_PER_BUCKET)
    .map(([tag]) => tag);
  // Если у бакета ещё нет собственных характерных тегов (тонкая коллекция),
  // сэмплируем хаб по его же seed-тегам — иначе антипрофиль строить не из чего.
  const hubTags = topBucketTags.length > 0 ? topBucketTags : bucket.seedTags.slice(0, 2);

  let releasesSampled = 0;
  for (const tag of hubTags) {
    const hubItems = await discover(http, { tag, slice: 'top', size: HUB_SAMPLE_SIZE });
    for (const hubItem of hubItems) {
      const album = await fetchAlbum(http, hubItem.url);
      if (!album) continue;
      releasesSampled += 1;
      for (const albumTag of album.tags) {
        hubTagCounts[albumTag] = (hubTagCounts[albumTag] ?? 0) + 1;
      }
    }
  }

  profile.buckets[bucket.id].stopTags = deriveStopTags({
    hubTagCounts,
    ownedTags,
    seedTags: bucket.seedTags,
    releasesSampled,
  });

  console.log(
    `  ${bucket.channelTitle}: хаб-теги [${hubTags.join(', ')}], сэмплировано релизов хаба: ${releasesSampled}, стоп-тегов найдено: ${profile.buckets[bucket.id].stopTags.length}`,
  );
}

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

  console.log(`\n${bucket.channelTitle} (${bucket.id})`);
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
