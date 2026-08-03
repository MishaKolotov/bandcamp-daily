import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeTag, pickDisplaySpelling } from './tags.ts';

test('canonicalizeTag: пробел, дефис и слитное написание дают один и тот же ключ', () => {
  assert.equal(canonicalizeTag('crust punk'), canonicalizeTag('crust-punk'));
  assert.equal(canonicalizeTag('crust-punk'), canonicalizeTag('crustpunk'));
  assert.equal(canonicalizeTag('d-beat'), canonicalizeTag('dbeat'));
  assert.equal(canonicalizeTag('dbeat'), canonicalizeTag('d beat'));
  assert.equal(canonicalizeTag('hardcore punk'), canonicalizeTag('hardcore-punk'));
});

test('canonicalizeTag: post-punk и post punk — тот же жанр, схлопываются намеренно', () => {
  assert.equal(canonicalizeTag('post-punk'), canonicalizeTag('post punk'));
});

test('canonicalizeTag: lo-fi схлопывается со слитным написанием', () => {
  assert.equal(canonicalizeTag('lo-fi'), canonicalizeTag('lofi'));
});

test('canonicalizeTag: амперсанд не трогается — r&b не схлопывается ни с чем посторонним', () => {
  assert.equal(canonicalizeTag('r&b'), 'r&b');
  assert.equal(canonicalizeTag('R&B'), 'r&b');
});

test('canonicalizeTag: голый однословный тег не совпадает с составным того же корня', () => {
  // Важный инвариант для buckets.ts: 'hardcore' и 'punk' держатся отдельным
  // сигналом от 'hardcore punk' — канонизация не имеет права их слить.
  assert.notEqual(canonicalizeTag('hardcore'), canonicalizeTag('hardcore punk'));
  assert.notEqual(canonicalizeTag('punk'), canonicalizeTag('hardcore punk'));
});

test('canonicalizeTag: регистр и крайние пробелы нормализуются', () => {
  assert.equal(canonicalizeTag('  Crust Punk  '), 'crustpunk');
  assert.equal(canonicalizeTag('D-BEAT'), 'dbeat');
});

test('canonicalizeTag: повторяющиеся и смешанные разделители схлопываются', () => {
  assert.equal(canonicalizeTag('d -  beat'), 'dbeat');
  assert.equal(canonicalizeTag('crust---punk'), 'crustpunk');
});

test('pickDisplaySpelling: побеждает самое частое написание', () => {
  const counts = new Map([
    ['d-beat', 4],
    ['dbeat', 9],
    ['d beat', 2],
  ]);
  assert.equal(pickDisplaySpelling(counts), 'dbeat');
});

test('pickDisplaySpelling: при равном счёте побеждает написание, увиденное раньше', () => {
  const counts = new Map([
    ['crust punk', 5],
    ['crustpunk', 5],
  ]);
  assert.equal(pickDisplaySpelling(counts), 'crust punk');
});

test('pickDisplaySpelling: единственное написание — оно и побеждает', () => {
  assert.equal(pickDisplaySpelling(new Map([['crust', 3]])), 'crust');
});

test('pickDisplaySpelling: пустой набор написаний — явная ошибка, а не тихий undefined', () => {
  assert.throws(() => pickDisplaySpelling(new Map()), /пустой набор написаний/);
});
