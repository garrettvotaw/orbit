import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../src/main/db.ts';
import {
  answerMessage,
  decisionRows,
  DecisionStore,
  deliverAnswers,
  forProductOwner,
  orbitTools,
  rerouteAnswers,
  toolRejection,
  withdrawnMessage,
} from '../src/main/decisions.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'orbit-decisions-'));
const shop = { id: 'shop', name: 'Storefront' };
const plain = {
  laneId: 'shop',
  laneName: shop.name,
  question: 'When a shopper picks up an order at a store, which store should the paperwork show?',
  today: 'The old app prints the store where the orders were picked up.',
  proposed: 'Show the store that placed the order instead.',
  options: ['The delivery store', 'The ordering store'],
  story: '100203',
};

test('the store numbers questions, dedupes open ones, and persists to its database', () => {
  const file = path.join(dir, 'a', 'orbit.db');
  let n = 0;
  const store = new DecisionStore(openDb(file), { now: () => 1_000 + n++, newId: () => `id-${n}` });
  const arrived: string[] = [];
  store.onChange((d) => arrived.push(d ? d.id : '-'));
  const first = store.add(plain);
  assert.equal(first.duplicate, false);
  assert.equal(first.decision.n, 1);
  assert.equal(first.decision.status, 'open');
  const again = store.add({
    ...plain,
    question: '  when a shopper picks up an order at a store which store should the paperwork show  ',
  });
  assert.equal(again.duplicate, true, 'same words, same lane, still open');
  assert.equal(again.decision.id, first.decision.id);
  const other = store.add({
    ...plain,
    laneId: 'cart',
    question: 'Should a cart with no tag be refused at the door?',
  });
  assert.equal(other.decision.n, 2);
  assert.deepEqual(arrived, [first.decision.id, other.decision.id]);

  assert.deepEqual(
    decisionRows(openDb(file))
      .all()
      .map((d) => d.n),
    [1, 2],
  );
  const reloaded = new DecisionStore(openDb(file));
  assert.equal(reloaded.open().length, 2);
  assert.equal(reloaded.open('shop').length, 1);
});

test('answering, delivering, sending, and dismissing move a question through its life', () => {
  const db = openDb(':memory:');
  let now = 10_000;
  const store = new DecisionStore(db, { now: () => now });
  const { decision } = store.add(plain);
  assert.equal(store.answer(decision.id, '   '), null, 'an empty answer is not an answer');
  now = 20_000;
  const answered = store.answer(decision.id, 'The delivery store.')!;
  assert.equal(answered.status, 'answered');
  assert.equal(answered.answeredAt, 20_000);
  assert.deepEqual(
    store.undelivered('shop').map((d) => d.id),
    [decision.id],
  );
  assert.equal(
    answerMessage(answered),
    'Product answer Q1 (story 100203): The delivery store.\nThe question was: When a shopper picks up an order at a store, which store should the paperwork show?',
  );
  assert.equal(store.list().length, 1, 'an answer the lane has not heard stays listed');
  store.markDelivered([decision.id]);
  assert.deepEqual(store.undelivered('shop'), []);
  assert.equal(store.list().length, 0, 'and leaves the moment it is delivered');
  assert.deepEqual(
    store.history('shop').map((d) => d.n),
    [1],
    'the lane can still see what it asked',
  );
  now = 20_000 + 4 * 24 * 60 * 60_000;
  assert.deepEqual(store.history('shop'), [], 'for a few days');
  store.reassign(decision.id, 'cart', 'Cart');
  assert.equal(store.get(decision.id)!.laneName, 'Cart');

  const second = store.add({ ...plain, question: 'Should the form remember the last store?' }).decision;
  store.markSent([second.id]);
  assert.equal(store.get(second.id)!.sentAt, now);
  assert.match(withdrawnMessage(second), /Q2 was withdrawn.*\(The delivery store\)/);
  assert.equal(store.dismiss(second.id)!.id, second.id);
  assert.equal(store.dismiss(second.id), null);
  assert.equal(store.open().length, 0);

  const back = new DecisionStore(db).get(decision.id)!;
  assert.equal(back.laneName, 'Cart', 'every change reached the database');
  assert.equal(back.answer, 'The delivery store.');
  assert.equal(back.deliveredAt, 20_000);
  assert.equal(new DecisionStore(db).get(second.id), undefined, 'and so did the dismissal');
});

test('forProductOwner writes a plain numbered list', () => {
  const store = new DecisionStore(openDb(':memory:'), { now: () => 5 });
  store.add(plain);
  store.add({
    laneId: 'cart',
    laneName: 'Cart',
    question: 'Can a cart be returned without a tag?',
    today: 'The old app refuses it.',
  });
  const text = forProductOwner(store.open(), Date.UTC(2026, 9, 8, 12));
  assert.match(text, /^Product questions from the Truck Care rebuild — /);
  assert.match(
    text,
    /1\. When a shopper picks up an order at a store, which store should the paperwork show\?\n   Today: The old app prints/,
  );
  assert.match(
    text,
    /   Proposed: Show the store that placed the order instead\.\n   Options: The delivery store \(recommended\) \/ The ordering store\n   From: Storefront · story 100203/,
  );
  assert.match(text, /2\. Can a cart be returned without a tag\?\n   Today: The old app refuses it\.\n   From: Cart$/);
});

test('the PM tool refuses developer wording with reasons, records plain questions, and lists them', async () => {
  const store = new DecisionStore(openDb(':memory:'), { now: () => 7 });
  const server = orbitTools(store, shop);
  assert.equal(server.name, 'orbit');
  const tools = (server as unknown as { instance: { _registeredTools: Record<string, unknown> } }).instance;
  const call = async (name: string, args: Record<string, unknown>) => {
    const reg = (
      tools as unknown as {
        _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }>;
      }
    )._registeredTools[name];
    assert.ok(reg, `${name} is registered`);
    return (await reg.handler(args, {})) as { isError?: boolean; content: Array<{ text: string }> };
  };

  const bad = await call('ask_product_owner', {
    question: 'Should the DTO send storeNumber to the API?',
    today: 'The mapper sends ORDNO.',
  });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /Not recorded/);
  assert.match(bad.content[0].text, /- question: .*storeNumber/);
  assert.match(bad.content[0].text, /- today: .*mapper.*ORDNO|- today: .*ORDNO/);
  assert.equal(store.open().length, 0);

  const ok = await call('ask_product_owner', {
    question: plain.question,
    today: plain.today,
    options: plain.options,
    story: '100203',
  });
  assert.equal(ok.isError, undefined);
  assert.match(ok.content[0].text, /^Recorded as Q1\. Do not wait on it/);
  assert.equal(store.open('shop').length, 1);

  const dup = await call('ask_product_owner', { question: plain.question, today: plain.today });
  assert.match(dup.content[0].text, /^Already asked as Q1/);
  assert.equal(store.open('shop').length, 1);

  const listed = await call('list_product_questions', {});
  assert.match(listed.content[0].text, /^Q1 \(open, story 100203\): When a shopper/);
  store.answer(store.open('shop')[0].id, 'The delivery store.');
  assert.match(
    (await call('list_product_questions', {})).content[0].text,
    /Q1 \(answered, story 100203\): .* -> The delivery store\./,
  );
});

test('toolRejection lists only the fields with problems', () => {
  const text = toolRejection([
    ['question', []],
    ['today', ['no developer words: api']],
  ]);
  assert.match(text, /^Not recorded\./);
  assert.match(text, /\n- today: no developer words: api\n/);
  assert.doesNotMatch(text, /- question/);
});

test('deliverAnswers survives the host calling back into it mid-send, and requeues a refused answer', () => {
  const store = new DecisionStore(openDb(':memory:'), { now: () => 9 });
  const { decision } = store.add(plain);
  store.answer(decision.id, 'The delivery store.');
  const sent: string[] = [];
  let live = true;
  let accept = true;
  // The real host appends the message to the feed (a change) before it marks the lane working, and
  // every change runs delivery again; this used to resend the same answer until the session died.
  const host = {
    isLive: () => live,
    send: (_lane: string, text: string) => {
      sent.push(text);
      deliverAnswers(store, host, 'shop');
      return accept;
    },
  };
  assert.equal(deliverAnswers(store, host, 'shop'), 1);
  assert.equal(sent.length, 1, 'delivered once');
  assert.match(sent[0], /^Product answer Q1 \(story 100203\): The delivery store\./);
  assert.deepEqual(store.undelivered('shop'), []);
  assert.equal(deliverAnswers(store, host, 'shop'), 0);

  const second = store.add({ ...plain, question: 'Should the form remember the last store?' }).decision;
  store.answer(second.id, 'Yes.');
  accept = false;
  assert.equal(deliverAnswers(store, host, 'shop'), 0, 'a refused send counts for nothing');
  assert.deepEqual(
    store.undelivered('shop').map((d) => d.id),
    [second.id],
    'and the answer waits for next time',
  );
  live = false;
  assert.equal(deliverAnswers(store, host, 'shop'), 0, 'a stopped lane gets nothing');
  assert.equal(sent.length, 2);
});

test('an answer whose moon has finished goes to the PM, and one with no lane at all counts as delivered', () => {
  const store = new DecisionStore(openDb(':memory:'), { now: () => 3 });
  const onMoon = store.add({ ...plain, laneId: 'story-shop-1', laneName: '1 · One' }).decision;
  const onGhost = store.add({
    ...plain,
    laneId: 'gone',
    laneName: 'Gone',
    question: 'Can a cart with no tag be taken in?',
  }).decision;
  const onLive = store.add({
    ...plain,
    laneId: 'shop',
    laneName: 'Shop',
    question: 'Should the form remember the last store?',
  }).decision;
  for (const d of [onMoon, onGhost, onLive]) store.answer(d.id, 'Yes.');
  const lanes = new Map([
    ['story-shop-1', { id: 'story-shop-1', name: '1 · One' }],
    ['shop', { id: 'shop', name: 'Shop' }],
  ]);
  const host = { isLive: () => false, lane: (id: string) => lanes.get(id) };
  const storyOf = (id: string) => (id === 'story-shop-1' ? { parentId: 'shop', finished: true } : null);
  rerouteAnswers(store, host, storyOf);
  assert.equal(store.get(onMoon.id)!.laneId, 'shop', 'the finished moon hands its answer to the PM');
  assert.equal(store.get(onMoon.id)!.laneName, 'Shop');
  assert.equal(store.get(onMoon.id)!.deliveredAt, null, 'still waiting, now for the PM');
  assert.notEqual(store.get(onGhost.id)!.deliveredAt, null, 'nowhere to go: done');
  assert.equal(store.get(onLive.id)!.deliveredAt, null, 'a live lane keeps its own');
  assert.deepEqual(
    store.undelivered('shop').map((d) => d.n),
    [1, 3],
  );
});
