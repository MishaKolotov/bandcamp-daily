import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Telegram, TelegramApiError } from './api.ts';

function stub(payload: unknown, status = 200) {
  const calls: { url: string; body: unknown }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(payload), { status });
  }) as unknown as typeof fetch;
  return { telegram: new Telegram('TOKEN', impl), calls };
}

test('токен подставляется в путь, метод — в конец', async () => {
  const { telegram, calls } = stub({ ok: true, result: { message_id: 5 } });
  await telegram.sendMessage({ chat_id: '1', text: 'привет' });
  assert.equal(calls[0]?.url, 'https://api.telegram.org/botTOKEN/sendMessage');
});

test('ok:false превращается в ошибку с описанием', async () => {
  const { telegram } = stub({ ok: false, description: 'chat not found' });
  await assert.rejects(() => telegram.sendMessage({ chat_id: '1', text: 'x' }), /chat not found/);
});

test('getUpdates отдаёт список обновлений', async () => {
  const { telegram, calls } = stub({ ok: true, result: [{ update_id: 7 }] });
  const updates = await telegram.getUpdates(3, 0);
  assert.deepEqual(updates, [{ update_id: 7 }]);
  assert.deepEqual(calls[0]?.body, { offset: 3, timeout: 0, allowed_updates: ['callback_query'] });
});

test('sendPhoto передаёт клавиатуру', async () => {
  const { telegram, calls } = stub({ ok: true, result: { message_id: 9 } });
  await telegram.sendPhoto({
    chat_id: '1',
    photo: 'https://img.test/a.jpg',
    caption: 'подпись',
    reply_markup: { inline_keyboard: [[{ text: 'ok', callback_data: 'x' }]] },
  });
  const body = calls[0]?.body as { reply_markup: { inline_keyboard: unknown[][] } };
  assert.equal(body.reply_markup.inline_keyboard.length, 1);
});

// --- Судейские решения ---

test('ошибка — это TelegramApiError с кодом, method и chat_id вызова', async () => {
  const { telegram } = stub({ ok: false, description: 'chat not found', error_code: 400 });
  await assert.rejects(
    () => telegram.sendMessage({ chat_id: '-1001', text: 'x' }),
    (error: unknown) => {
      assert.ok(error instanceof TelegramApiError);
      assert.equal(error.method, 'sendMessage');
      assert.equal(error.errorCode, 400);
      assert.equal(error.chatId, '-1001');
      assert.equal(error.recoverable, false);
      return true;
    },
  );
});

test('рейт-лимит (429) несёт retry_after и помечен восстановимым', async () => {
  const { telegram } = stub({
    ok: false,
    error_code: 429,
    description: 'Too Many Requests: retry after 5',
    parameters: { retry_after: 5 },
  });
  await assert.rejects(
    () => telegram.sendMessage({ chat_id: '-1002', text: 'x' }),
    (error: unknown) => {
      assert.ok(error instanceof TelegramApiError);
      assert.equal(error.retryAfter, 5);
      assert.equal(error.recoverable, true);
      return true;
    },
  );
});

test('ошибка 5xx (Telegram недоступен) тоже помечена восстановимой', async () => {
  const { telegram } = stub({ ok: false, error_code: 502, description: 'Bad Gateway' });
  await assert.rejects(
    () => telegram.sendMessage({ chat_id: '1', text: 'x' }),
    (error: unknown) => {
      assert.ok(error instanceof TelegramApiError);
      assert.equal(error.recoverable, true);
      return true;
    },
  );
});

test('ошибка отправки владельцу и ошибка отправки в канал различимы по chat_id', async () => {
  const owner = stub({ ok: false, description: 'blocked', error_code: 403 });
  const channel = stub({ ok: false, description: 'not enough rights', error_code: 403 });
  let ownerError: unknown;
  let channelError: unknown;
  try {
    await owner.telegram.sendMessage({ chat_id: 7566215, text: 'x' });
  } catch (error) {
    ownerError = error;
  }
  try {
    await channel.telegram.sendMessage({ chat_id: '@somechannel', text: 'x' });
  } catch (error) {
    channelError = error;
  }
  assert.ok(ownerError instanceof TelegramApiError && ownerError.chatId === 7566215);
  assert.ok(channelError instanceof TelegramApiError && channelError.chatId === '@somechannel');
});

test('getUpdates по умолчанию использует длинный опрос, а не busy-poll', async () => {
  const { telegram, calls } = stub({ ok: true, result: [] });
  await telegram.getUpdates(1);
  const body = calls[0]?.body as { timeout: number };
  assert.ok(body.timeout > 0, `ожидался ненулевой timeout, получили ${body.timeout}`);
});

test('editMessageText уходит с текстом и опциональной клавиатурой', async () => {
  const { telegram, calls } = stub({ ok: true, result: true });
  await telegram.editMessageText({
    chat_id: '1',
    message_id: 5,
    text: 'новый текст',
    reply_markup: { inline_keyboard: [[{ text: 'ok', callback_data: 'x' }]] },
  });
  assert.equal(calls[0]?.url, 'https://api.telegram.org/botTOKEN/editMessageText');
  const body = calls[0]?.body as { text: string; reply_markup: { inline_keyboard: unknown[][] } };
  assert.equal(body.text, 'новый текст');
  assert.equal(body.reply_markup.inline_keyboard.length, 1);
});

test('нечитаемый ответ (5xx с не-JSON телом) превращается в TelegramApiError, а не роняет SyntaxError', async () => {
  const impl = (async () => new Response('<html>Bad Gateway</html>', { status: 502 })) as unknown as typeof fetch;
  const telegram = new Telegram('TOKEN', impl);
  await assert.rejects(
    () => telegram.sendMessage({ chat_id: '1', text: 'x' }),
    (error: unknown) => {
      assert.ok(error instanceof TelegramApiError);
      assert.equal(error.errorCode, 502);
      assert.equal(error.recoverable, true);
      return true;
    },
  );
});
