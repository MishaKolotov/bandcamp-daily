import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candidate } from '../bandcamp/types.ts';
import { TelegramApiError } from './api.ts';
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
    posted: [],
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
    postToChannel: async (bucket, text) => {
      log.push(`post:${bucket}:${text.slice(0, 1)}`);
    },
    replaceCard: async (edit) => {
      log.push(`replace:${edit.messageId}:${edit.hasPhoto}:${itemIdOf(edit)}`);
    },
    closeCard: async (edit) => {
      log.push(`close:${edit.messageId}:${edit.hasPhoto}:${edit.keyboard.inline_keyboard.length}`);
    },
    ack: async (_id, text) => {
      log.push(`ack:${text ?? ''}`);
    },
  };
}

function failingPostDeps(errorCode: number | undefined, retryAfter?: number): ApproveDeps & { log: string[] } {
  const base = deps();
  return {
    ...base,
    postToChannel: async () => {
      throw new TelegramApiError('sendMessage', 'boom', errorCode, retryAfter, 'chat');
    },
  };
}

const callback = (updateId: number, data: string) => ({
  update_id: updateId,
  callback_query: { id: 'q', data, message: { message_id: 100, chat: { id: 1 } } },
});

test('нажатие «в канал» публикует и записывает в posted по URL', async () => {
  const s = state();
  const d = deps();
  await handleUpdates([callback(5, 'post|crust|1')], s, d);
  assert.ok(d.log.some((entry) => entry.startsWith('post:crust')));
  assert.equal(s.posted.length, 1);
  assert.equal(s.posted[0]?.itemId, 1);
  assert.equal(s.posted[0]?.url, 'https://x.test/album/1');
  assert.equal(s.pending.length, 0);
});

test('после публикации карточка закрывается без кнопок', async () => {
  const s = state();
  const d = deps();
  await handleUpdates([callback(5, 'post|crust|1')], s, d);
  assert.ok(d.log.some((entry) => entry === 'close:100:false:0'));
});

test('скип копит штраф по тегам, но не по опорному тегу своего бакета', async () => {
  const s = state();
  s.pending[0]!.candidate.tags = ['crust', 'raw'];
  const d = deps();
  await handleUpdates([callback(5, 'skip|crust|1')], s, d);
  assert.ok(!d.log.some((entry) => entry.startsWith('post:')));
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

test('«другой» без запаса кандидатов закрывает карточку', async () => {
  const s = state();
  s.pending[0]!.alternatives = [];
  const d = deps();
  await handleUpdates([callback(5, 'next|crust|1')], s, d);
  assert.ok(d.log.some((entry) => entry.startsWith('close:100')));
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
  await handleUpdates([callback(5, 'post|crust|999')], s, d);
  assert.ok(d.log.some((entry) => entry.startsWith('ack:')));
  assert.equal(s.posted.length, 0);
  assert.equal(s.pending.length, 1);
});

test('битый callback не роняет обработку остальных', async () => {
  const s = state();
  const d = deps();
  await handleUpdates([callback(4, 'мусор'), callback(5, 'skip|crust|1')], s, d);
  assert.equal(s.pending.length, 0);
  assert.equal(s.lastUpdateId, 5);
});

test('провал публикации (recoverable — рейт-лимит): карточка остаётся, публикация не засчитана', async () => {
  const s = state();
  const d = failingPostDeps(429, 5);
  await handleUpdates([callback(5, 'post|crust|1')], s, d);
  assert.equal(s.posted.length, 0);
  assert.equal(s.pending.length, 1, 'карточку нужно оставить — можно нажать ещё раз');
  const ack = d.log.find((entry) => entry.startsWith('ack:'));
  assert.ok(ack, 'владелец должен получить ack с объяснением');
  assert.match(ack ?? '', /ещё раз|повтор/i);
});

test('провал публикации (misconfiguration — 403): сообщение владельцу отличается от рейт-лимита', async () => {
  const s = state();
  const d = failingPostDeps(403);
  await handleUpdates([callback(5, 'post|crust|1')], s, d);
  assert.equal(s.posted.length, 0);
  assert.equal(s.pending.length, 1);
  const ack = d.log.find((entry) => entry.startsWith('ack:'));
  assert.ok(ack);
  assert.match(ack ?? '', /настро|канал/i);
});

test('провал публикации 5xx считается recoverable', async () => {
  const s = state();
  const d = failingPostDeps(500);
  await handleUpdates([callback(5, 'post|crust|1')], s, d);
  const ack = d.log.find((entry) => entry.startsWith('ack:'));
  assert.match(ack ?? '', /ещё раз|повтор/i);
});

test('идемпотентность: URL, уже отмеченный опубликованным, не публикуется повторно', async () => {
  const s = state();
  s.posted.push({
    itemId: 1,
    bucket: 'crust',
    url: s.pending[0]!.candidate.url,
    title: 'T',
    artist: 'A',
    postedAt: '2026-08-01',
  });
  const d = deps();
  await handleUpdates([callback(5, 'post|crust|1')], s, d);
  assert.ok(!d.log.some((entry) => entry.startsWith('post:')), 'postToChannel не должен вызываться повторно');
  assert.equal(s.posted.length, 1, 'запись в posted не должна задваиваться');
  assert.equal(s.pending.length, 0, 'зависшую карточку всё равно нужно убрать из pending');
});

test('идемпотентность: двойное нажатие «в канал» в одном пакете обновлений публикует только один раз', async () => {
  const s = state();
  const d = deps();
  await handleUpdates([callback(5, 'post|crust|1'), callback(6, 'post|crust|1')], s, d);
  assert.equal(d.log.filter((entry) => entry.startsWith('post:')).length, 1);
  assert.equal(s.posted.length, 1);
});
