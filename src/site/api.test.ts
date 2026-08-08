import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SiteApi, type PickRequest } from './api.ts';

function stub(payload: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(payload), { status });
  }) as unknown as typeof fetch;
  return { api: new SiteApi('https://site.test', 'SECRET', impl), calls };
}

const pick: PickRequest = {
  bucket: 'crust',
  bucketTitle: 'краст',
  candidate: {
    url: 'https://band.bandcamp.com/album/x',
    title: 'T',
    artist: 'A',
    label: null,
    tags: ['crust'],
    releasedAt: null,
    artUrl: null,
    origin: 'fresh',
  },
  penaltyTags: ['stenchcore'],
  total: 1.5,
  alternatives: [],
};

test('контекст запрашивается с Bearer-секретом', async () => {
  const { api, calls } = stub({ seen: ['u'], feedbackTags: { crust: 2 }, lastBucket: 'crust' });
  const ctx = await api.readContext();
  assert.equal(calls[0]?.url, 'https://site.test/api/picker/context');
  assert.equal((calls[0]?.init.headers as Record<string, string>).Authorization, 'Bearer SECRET');
  assert.deepEqual(ctx.seen, ['u']);
  assert.equal(ctx.lastBucket, 'crust');
});

test('пик уходит POST-ом с телом победителя', async () => {
  const { api, calls } = stub({ messageId: 7 });
  const sent = await api.sendPick(pick);

  assert.equal(calls[0]?.url, 'https://site.test/api/picker/pick');
  assert.equal(calls[0]?.init.method, 'POST');
  const body = JSON.parse(String(calls[0]?.init.body));
  assert.equal(body.bucket, 'crust');
  assert.equal(body.bucketTitle, 'краст');
  assert.deepEqual(body.penaltyTags, ['stenchcore']);
  assert.equal(sent.messageId, 7);
});

test('не-2xx превращается в понятную ошибку, а не в тихий undefined', async () => {
  const { api } = stub({ error: 'unauthorized' }, 401);
  await assert.rejects(() => api.readContext(), /401/);
});

test('не-2xx на отправке пика тоже роняет, а не проглатывается', async () => {
  // Проглоченная ошибка здесь означала бы «джоб зелёный, карточка не пришла» —
  // молчание подборщика ниже порога выглядит ровно так же, и владелец не узнал
  // бы о поломке, пока сам не спросит.
  const { api } = stub({ error: 'bad request' }, 400);
  await assert.rejects(() => api.sendPick(pick), /400/);
});

test('хвостовой слеш в SITE_URL не превращает путь в //api', async () => {
  const calls: { url: string }[] = [];
  const impl = (async (url: string) => {
    calls.push({ url: String(url) });
    return new Response(JSON.stringify({ seen: [], feedbackTags: {}, lastBucket: null }), { status: 200 });
  }) as unknown as typeof fetch;

  await new SiteApi('https://site.test/', 'S', impl).readContext();
  assert.equal(calls[0]?.url, 'https://site.test/api/picker/context');
});
