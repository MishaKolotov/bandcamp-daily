import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJson } from './state.ts';

test('чтение отсутствующего файла возвращает значение по умолчанию', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bc-state-'));
  assert.deepEqual(await readJson(join(dir, 'nope.json'), { seen: [] }), { seen: [] });
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

test('битый JSON не роняет запуск, а откатывается к умолчанию', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bc-state-'));
  const path = join(dir, 'broken.json');
  await writeJson(path, { a: 1 });
  await (await import('node:fs/promises')).writeFile(path, '{oops', 'utf8');
  assert.deepEqual(await readJson(path, { a: 0 }), { a: 0 });
  await rm(dir, { recursive: true, force: true });
});
