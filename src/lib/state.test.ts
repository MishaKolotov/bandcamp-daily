import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJson } from './state.ts';

async function withCapturedErrors<T>(fn: () => Promise<T>): Promise<{ result: T; calls: unknown[][] }> {
  const original = console.error;
  const calls: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    console.error = original;
  }
}

test('чтение отсутствующего файла возвращает значение по умолчанию и не пишет предупреждение', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bc-state-'));
  const path = join(dir, 'nope.json');
  const { result, calls } = await withCapturedErrors(() => readJson(path, { seen: [] }));
  assert.deepEqual(result, { seen: [] });
  assert.deepEqual(calls, []);
  await rm(dir, { recursive: true, force: true });
});

test('запись и чтение возвращают то же значение', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bc-state-'));
  const path = join(dir, 'a/b/seen.json');
  await writeJson(path, { seen: [1, 2] });
  assert.deepEqual(await readJson(path, { seen: [] as number[] }), { seen: [1, 2] });
  await rm(dir, { recursive: true, force: true });
});

test('файл пишется с отступами и переводом строки в конце — чтобы дифф в git читался', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bc-state-'));
  const path = join(dir, 'x.json');
  await writeJson(path, { a: 1 });
  const raw = await readFile(path, 'utf8');
  assert.equal(raw, '{\n  "a": 1\n}\n');
  await rm(dir, { recursive: true, force: true });
});

test('битый JSON не роняет запуск, откатывается к умолчанию и пишет предупреждение с путём', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bc-state-'));
  const path = join(dir, 'broken.json');
  await writeJson(path, { a: 1 });
  await writeFile(path, '{oops', 'utf8');
  const { result, calls } = await withCapturedErrors(() => readJson(path, { a: 0 }));
  assert.deepEqual(result, { a: 0 });
  assert.equal(calls.length, 1);
  assert.ok(String(calls[0]?.[0]).includes(path));
  await rm(dir, { recursive: true, force: true });
});

test('запись атомарна: осиротевший временный файл рядом не портит чтение состояния', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bc-state-'));
  const path = join(dir, 'atomic.json');
  await writeJson(path, { a: 1 });
  // симулируем временный файл, оставшийся от прерванной предыдущей записи
  await writeFile(`${path}.99999.tmp`, '{oops', 'utf8');
  assert.deepEqual(await readJson(path, { a: 0 }), { a: 1 });
  await rm(dir, { recursive: true, force: true });
});

test('недостающее поле в сохранённом файле подставляется из умолчания, сохранённые поля побеждают', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bc-state-'));
  const path = join(dir, 'merge.json');
  await writeJson(path, { seen: [1, 2] });
  const result = await readJson(path, { seen: [] as number[], offset: 0 });
  assert.deepEqual(result, { seen: [1, 2], offset: 0 });
  await rm(dir, { recursive: true, force: true });
});

test('сохранённый массив возвращается как есть, без слияния', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bc-state-'));
  const path = join(dir, 'array.json');
  await writeJson(path, [1, 2, 3]);
  assert.deepEqual(await readJson(path, [] as number[]), [1, 2, 3]);
  await rm(dir, { recursive: true, force: true });
});

test('сохранённый скаляр возвращается как есть, без слияния', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bc-state-'));
  const path = join(dir, 'scalar.json');
  await writeJson(path, 42);
  assert.equal(await readJson(path, 0), 42);
  await rm(dir, { recursive: true, force: true });
});
