import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candidate } from '../bandcamp/types.ts';
import { parseCallback } from './card.ts';
import { handleUpdates, type ApproveDeps, type ApproveState, type CardEdit } from './approve.ts';

const candidate = (itemId: number, over: Partial<Candidate> = {}): Candidate => ({
  itemId,
  url: `https://x.test/album/${itemId}`,
  title: 'T',
  artist: 'A',
  label: null,
  tags: ['crust'],
  releasedAt: '2026-08-01',
  artUrl: null,
  alsoCollected: 0,
  origin: 'fresh',
  ...over,
});

function state(): ApproveState {
  return {
    pending: [
      {
        bucket: 'crust',
        messageId: 100,
        hasPhoto: false,
        candidate: candidate(1),
        matchedTags: ['crust'],
        alternatives: [candidate(2)],
      },
    ],
    feedbackTags: {},
    seen: [],
    lastUpdateId: 0,
  };
}

/** Достаёт itemId из клавиатуры, которую approve.ts построил через buildCard — так тест проверяет реальное содержимое, а не догадывается о нём. */
function itemIdOf(edit: CardEdit): number | undefined {
  const button = edit.keyboard.inline_keyboard[0]?.[0];
  return button ? parseCallback(button.callback_data)?.itemId : undefined;
}

function deps(): ApproveDeps & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    replaceCard: async (edit) => {
      log.push(`replace:${edit.messageId}:${edit.hasPhoto}:${itemIdOf(edit)}`);
    },
    deleteCard: async (messageId) => {
      log.push(`delete:${messageId}`);
    },
    ack: async (_id, text) => {
      log.push(`ack:${text ?? ''}`);
    },
  };
}

const callback = (updateId: number, data: string) => ({
  update_id: updateId,
  callback_query: { id: 'q', data, message: { message_id: 100, chat: { id: 1 } } },
});

test('после скипа карточка сносится из лички', async () => {
  const s = state();
  const d = deps();
  await handleUpdates([callback(5, 'skip|crust|1')], s, d);
  assert.ok(d.log.includes('delete:100'));
});

test('скип копит штраф по тегам, но не по опорному тегу своего бакета', async () => {
  const s = state();
  s.pending[0]!.candidate.tags = ['crust', 'raw'];
  const d = deps();
  await handleUpdates([callback(5, 'skip|crust|1')], s, d);
  assert.equal(s.feedbackTags['crust'], undefined, 'опорный тег бакета не должен штрафоваться');
  assert.equal(s.feedbackTags['raw'], 1);
  assert.equal(s.pending.length, 0);
});

test('скип релиза с одним лишь опорным тегом не пишет вообще никакого штрафа', async () => {
  const s = state();
  s.pending[0]!.candidate.tags = ['crust'];
  await handleUpdates([callback(5, 'skip|crust|1')], s, deps());
  assert.deepEqual(s.feedbackTags, {});
});

test('«другой» подменяет карточку следующим кандидатом', async () => {
  const s = state();
  const d = deps();
  await handleUpdates([callback(5, 'next|crust|1')], s, d);
  assert.ok(d.log.some((entry) => entry.startsWith('replace:100:false:2')));
  assert.equal(s.pending[0]?.candidate.itemId, 2);
  assert.equal(s.pending[0]?.alternatives.length, 0);
});

test('«другой» без запаса кандидатов сносит карточку', async () => {
  const s = state();
  s.pending[0]!.alternatives = [];
  const d = deps();
  await handleUpdates([callback(5, 'next|crust|1')], s, d);
  assert.ok(d.log.includes('delete:100'));
  assert.equal(s.pending.length, 0);
});

test('редактирование зовёт editMessageText/editMessageCaption по тому, как сообщение отправили изначально, а не по обложке текущего кандидата', async () => {
  // Отправлено как фото (hasPhoto: true), новый кандидат без обложки —
  // Telegram не даёt превратить фото-сообщение в текстовое при редактировании,
  // так что дальше оно всё равно остаётся "фото"-сообщением.
  const withPhoto = state();
  withPhoto.pending[0]!.hasPhoto = true;
  withPhoto.pending[0]!.alternatives = [candidate(2, { artUrl: null })];
  const d1 = deps();
  await handleUpdates([callback(5, 'next|crust|1')], withPhoto, d1);
  assert.ok(d1.log.some((entry) => entry.startsWith('replace:100:true:2')));

  // Отправлено как текст (hasPhoto: false), новый кандидат ТЕПЕРЬ с обложкой —
  // сообщение остаётся текстовым, редактируется editMessageText.
  const withoutPhoto = state();
  withoutPhoto.pending[0]!.hasPhoto = false;
  withoutPhoto.pending[0]!.alternatives = [candidate(2, { artUrl: 'https://x.test/art.jpg' })];
  const d2 = deps();
  await handleUpdates([callback(5, 'next|crust|1')], withoutPhoto, d2);
  assert.ok(d2.log.some((entry) => entry.startsWith('replace:100:false:2')));
});

test('всё показанное попадает в seen по URL, а не по itemId', async () => {
  const s = state();
  await handleUpdates([callback(5, 'skip|crust|1')], s, deps());
  assert.ok(s.seen.includes('https://x.test/album/1'));
  assert.ok(!s.seen.includes(1 as unknown as string));
});

test('lastUpdateId двигается, чтобы обновления не обрабатывались дважды', async () => {
  const s = state();
  await handleUpdates([callback(9, 'skip|crust|1')], s, deps());
  assert.equal(s.lastUpdateId, 9);
});

test('нажатие по неизвестной карточке подтверждается и игнорируется', async () => {
  const s = state();
  const d = deps();
  await handleUpdates([callback(5, 'skip|crust|999')], s, d);
  assert.ok(d.log.some((entry) => entry.startsWith('ack:')));
  assert.equal(s.pending.length, 1);
});

test('битый callback не роняет обработку остальных', async () => {
  const s = state();
  const d = deps();
  await handleUpdates([callback(4, 'мусор'), callback(5, 'skip|crust|1')], s, d);
  assert.equal(s.pending.length, 0);
  assert.equal(s.lastUpdateId, 5);
});
