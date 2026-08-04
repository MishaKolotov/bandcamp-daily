/**
 * Еженедельный скрипт: строит data/neighbors.json — фанатов, чьи коллекции
 * сильнее всего пересекаются с коллекцией владельца, вместе с их
 * коллекциями. Ежедневный запуск (Task 21) берёт архивный пул кандидатов
 * из этого файла без единого сетевого запроса — вся сеть здесь.
 *
 * Параметры и арифметика (владелец: fan 7566215, 223 релиза в коллекции;
 * `collection_items` продвигается порциями примерно в 20 позиций за
 * запрос независимо от `count`, поэтому коллекция сравнимого с владельцем
 * размера читается примерно за 12 запросов — см. комментарий у MAX_PAGES
 * в src/bandcamp/fan.ts):
 *
 * - SEED_COUNT = 40 — семена графа, разреженная выборка по всей коллекции
 *   владельца (см. pickSeeds в src/pipeline/neighbors.ts). Каждое семя —
 *   один запрос к tralbumcollectors, итого 40 запросов. Дёшево, поэтому
 *   щедро: больше семян — шире охват коллекции при равной цене.
 * - CANDIDATE_LIMIT = 80 — сколько самых часто всплывающих в списках
 *   покупателей семян фанатов проверяется на полное пересечение. Это
 *   основной множитель стоимости, но запас относительно NEIGHBOR_LIMIT
 *   нужен: часть кандидатов — мёртвые/приватные/переименованные аккаунты
 *   (computeNeighbors их пропускает, не роняя прогон).
 * - STRANGER_MAX_PAGES = 15 — явный предел страниц на чужую коллекцию.
 *   Знаменатель близости в computeNeighbors — это min(theirs.length, 223),
 *   так что дочитывать коллекцию плодовитого коллекционера дальше
 *   пары сотен позиций бессмысленно: она уже не может уменьшить дробь.
 *   15 страниц ≈ 300 позиций (15 × ~20) — с запасом покрывает весь размер
 *   владельца. Без явного predела (дефолт в fetchFanItems — MAX_PAGES=60,
 *   подобранный под ЕГО коллекцию) наихудший случай — 80 кандидатов по 60
 *   страниц — почти 5000 запросов и больше часа только на эту часть.
 * - NEIGHBOR_LIMIT = 40 — сколько соседей оставить после сортировки по
 *   весу. Столько фанатов достаточно, чтобы у archive-пула (Task 21) была
 *   опора не на единицы голосов.
 * - MIN_COLLECTION_SIZE = 112 — минимальный размер ЧУЖОЙ коллекции, ниже
 *   которого сосед отбрасывается независимо от overlap (см. подробный
 *   разбор у NeighborOptions.minCollectionSize в src/pipeline/neighbors.ts).
 *   Половина владельческих 223: та точка, где один случайно общий релиз
 *   перестаёт двигать вес больше, чем на удвоенное "зерно" метрики
 *   (2/223 ≈ 0.009). На первом живом прогоне без этого порога топ-1 занял
 *   сосед с коллекцией из 11 релизов и 2 общими — 2/11 = 0.18, выше любого
 *   настоящего совпадения в списке.
 *
 * Стоимость прогона (900 мс между запросами):
 *   ~12 (своя коллекция) + 40 (семена → collectors) + до 80×15 = 1200
 *   (кандидаты → чужие коллекции) ≈ до 1252 запросов ≈ до ~19 минут.
 *   Это потолок: у большинства кандидатов настоящая коллекция меньше
 *   300 позиций, и постраничный обход останавливается сам (more_available
 *   становится false) задолго до STRANGER_MAX_PAGES — реальное время
 *   обычно заметно меньше потолка.
 */
import { access, stat } from 'node:fs/promises';
import { Http } from '../src/lib/http.ts';
import { writeJson } from '../src/lib/state.ts';
import { fetchFanItems } from '../src/bandcamp/fan.ts';
import { fetchCollectors } from '../src/bandcamp/collectors.ts';
import { computeNeighbors } from '../src/pipeline/neighbors.ts';

const OWNER_FAN_ID = 7566215;
const NEIGHBORS_PATH = 'data/neighbors.json';

const SEED_COUNT = 40;
const CANDIDATE_LIMIT = 80;
const NEIGHBOR_LIMIT = 40;
/** Минимальный размер чужой коллекции — см. обоснование в шапке файла. */
const MIN_COLLECTION_SIZE = 112;
/** Явный предел страниц на ЧУЖУЮ коллекцию — см. обоснование в шапке файла. */
const STRANGER_MAX_PAGES = 15;
/** Как часто печатать прогресс по проверенным кандидатам. */
const PROGRESS_EVERY = 10;

/**
 * data/neighbors.json перезаписывается целиком каждым прогоном — как и
 * data/profile.json в bin/build-profile.ts, случайный повторный запуск не
 * должен молча стирать предыдущий результат без явного намерения.
 */
async function assertWritable(path: string): Promise<void> {
  if (process.argv.includes('--force')) return;
  try {
    await access(path);
  } catch {
    return;
  }
  console.error(
    `${path} уже существует. Повторный прогон затрёт текущий файл.\n` +
      'Если это то, что нужно — запусти с флагом --force.',
  );
  process.exit(1);
}

await assertWritable(NEIGHBORS_PATH);

const http = new Http({ cacheDir: '.cache', minDelayMs: 900 });

console.log(`Читаю коллекцию владельца (fan ${OWNER_FAN_ID})...`);
const mine = await fetchFanItems(http, OWNER_FAN_ID, 'collection');
console.log(`Релизов в коллекции: ${mine.length}`);

console.log(
  `\nСтрою граф соседей: ${SEED_COUNT} семян, до ${CANDIDATE_LIMIT} кандидатов, ` +
    `у каждого читаю не больше ${STRANGER_MAX_PAGES} страниц его коллекции...`,
);

let examined = 0;
let skipped = 0;

const neighbors = await computeNeighbors(
  {
    collectors: (albumId) => fetchCollectors(http, albumId, 40),
    collectionOf: async (fanId) => {
      examined += 1;
      try {
        const theirs = await fetchFanItems(http, fanId, 'collection', {
          maxPages: STRANGER_MAX_PAGES,
        });
        if (examined % PROGRESS_EVERY === 0) {
          console.log(`  проверено кандидатов: ${examined}/${CANDIDATE_LIMIT} (пропущено: ${skipped})`);
        }
        return theirs;
      } catch (error) {
        skipped += 1;
        // computeNeighbors сам ловит эту ошибку и пропускает кандидата, не
        // роняя весь прогон (см. комментарий у deps.collectionOf в
        // src/pipeline/neighbors.ts) — здесь только считаем, сколько раз
        // это случилось, для итогового отчёта.
        throw error;
      }
    },
  },
  {
    ownerFanId: OWNER_FAN_ID,
    mine,
    seedCount: SEED_COUNT,
    candidateLimit: CANDIDATE_LIMIT,
    neighborLimit: NEIGHBOR_LIMIT,
    minCollectionSize: MIN_COLLECTION_SIZE,
  },
);

const generatedAt = new Date().toISOString().slice(0, 10);
await writeJson(NEIGHBORS_PATH, { generatedAt, neighbors });

const fileStat = await stat(NEIGHBORS_PATH);

console.log('\n=== Итог ===');
console.log(
  `Кандидатов проверено: ${examined} из ${CANDIDATE_LIMIT}, пропущено недоступных: ${skipped}.`,
);
console.log(`Соседей найдено: ${neighbors.length} (лимит ${NEIGHBOR_LIMIT}).`);

if (neighbors.length > 0) {
  const sortedWeights = neighbors.map((n) => n.weight).sort((a, b) => a - b);
  const min = sortedWeights[0]!;
  const max = sortedWeights[sortedWeights.length - 1]!;
  const median = sortedWeights[Math.floor(sortedWeights.length / 2)]!;
  console.log(`Близость: минимум ${min}, медиана ${median}, максимум ${max}.`);
  console.log('Топ-10 по близости:');
  for (const neighbor of neighbors.slice(0, 10)) {
    console.log(`  fan ${neighbor.fanId}: близость ${neighbor.weight}, релизов ${neighbor.itemUrls.length}`);
  }
} else {
  console.warn(
    'Соседей с пересечением не найдено — это неожиданно. Проверить SEED_COUNT/CANDIDATE_LIMIT ' +
      'или сходить в сеть руками за одним кандидатом вручную.',
  );
}

console.log(`\nЗаписано в ${NEIGHBORS_PATH} (${(fileStat.size / 1024).toFixed(1)} КБ).`);
