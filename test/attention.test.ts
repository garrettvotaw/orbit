import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AttentionQueue } from '../src/main/attention.ts';
import type { Question } from '../src/shared/types.ts';

const q: Question[] = [
  {
    question: 'Which Store code?',
    header: 'Store code',
    options: [
      { label: 'StoreCode', description: '' },
      { label: 'BranchCode', description: '' },
    ],
    multiSelect: false,
  },
];
let t = 0;
const clock = () => ++t;

test('ask creates a question item and resolves on answer', async () => {
  const aq = new AttentionQueue({ now: clock });
  const p = aq.ask('cart', 'tu1', q, 'because');
  const item = aq.items()[0];
  assert.equal(item.kind, 'question');
  assert.equal(item.laneId, 'cart');
  assert.ok(aq.answer(item.id, { 'Which Store code?': 'BranchCode' }));
  assert.deepEqual(await p, { answers: { 'Which Store code?': 'BranchCode' } });
  assert.equal(aq.items().length, 0);
});

test('answer carries annotations through, and drops an empty set', async () => {
  const aq = new AttentionQueue({ now: clock });
  const p = aq.ask('cart', 'tu1', q, null);
  aq.answer(
    aq.items()[0].id,
    { 'Which Store code?': 'BranchCode' },
    { 'Which Store code?': { notes: 'Store forms only' } },
  );
  assert.deepEqual(await p, {
    answers: { 'Which Store code?': 'BranchCode' },
    annotations: { 'Which Store code?': { notes: 'Store forms only' } },
  });
  const p2 = aq.ask('cart', 'tu2', q, null);
  aq.answer(aq.items()[0].id, { 'Which Store code?': 'BranchCode' }, {});
  assert.deepEqual(await p2, { answers: { 'Which Store code?': 'BranchCode' } });
});

test('ordering: questions, then blocked, then errors, oldest first', () => {
  const aq = new AttentionQueue({ now: clock });
  const e = aq.raiseError('shop', 'api', '503');
  const b = aq.raiseBlocked('shop', '100107', 'decide');
  void aq.ask('cart', 'tu', q, null);
  const b2 = aq.raiseBlocked('cart', '1', 'x');
  assert.deepEqual(
    aq.items().map((i) => i.kind),
    ['question', 'blocked', 'blocked', 'error'],
  );
  assert.deepEqual(
    aq
      .items()
      .slice(1, 3)
      .map((i) => i.id),
    [b, b2],
  );
  assert.equal(aq.items()[3].id, e);
});

test('abort signal removes the item and rejects', async () => {
  const aq = new AttentionQueue({ now: clock });
  const ac = new AbortController();
  const p = aq.ask('shop', 'tu', q, null, ac.signal);
  ac.abort();
  await assert.rejects(p, /aborted/);
  assert.equal(aq.items().length, 0);
});

test('clearLane drops everything for a lane and rejects its questions', async () => {
  const aq = new AttentionQueue({ now: clock });
  const p = aq.ask('shop', 'tu', q, null);
  aq.raiseBlocked('shop', 's', 'd');
  aq.raiseBlocked('cart', 's', 'd');
  aq.clearLane('shop');
  await assert.rejects(p, /lane cleared/);
  assert.deepEqual(
    aq.items().map((i) => i.laneId),
    ['cart'],
  );
});

test('onChange fires on every mutation', () => {
  const aq = new AttentionQueue({ now: clock });
  let n = 0;
  aq.onChange(() => n++);
  const id = aq.raiseError('shop', 'exit', 'x');
  aq.dismiss(id);
  assert.equal(n, 2);
});

test('answer on unknown id is false', () => {
  assert.equal(new AttentionQueue().answer('nope', {}), false);
});

test('raiseError keeps the tracker ref on the card', () => {
  const aq = new AttentionQueue();
  const id = aq.raiseError('cart', 'tracker-auth', 'Jira 401', { kind: 'jira', site: 'contoso.atlassian.net' });
  const card = aq.items().find((i) => i.id === id);
  assert.ok(card && card.kind === 'error');
  assert.deepEqual(card.tracker, { kind: 'jira', site: 'contoso.atlassian.net' });
  assert.equal(card.code, 'tracker-auth');
});
