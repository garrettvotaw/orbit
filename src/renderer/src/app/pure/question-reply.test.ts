import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answered, buildReply, EMPTY_DRAFT, pick, typeOther } from './question-reply.ts';
import type { Question } from '../../../../shared/types.ts';

const single: Question = {
  question: 'Which Store code?',
  header: 'Store code',
  options: [
    { label: 'StoreCode', description: '5-char store code', preview: 'STR01' },
    { label: 'BranchCode', description: 'ERP site number' },
  ],
  multiSelect: false,
};
const multi: Question = {
  question: 'Which checks?',
  header: 'Checks',
  options: [
    { label: 'Lint', description: '' },
    { label: 'Unit', description: '' },
    { label: 'E2E', description: '' },
  ],
  multiSelect: true,
};

test('a single-select pick replaces the last one and clears Other', () => {
  const typed = typeOther(EMPTY_DRAFT, 'something else', false);
  const d = pick(pick(typed, 'StoreCode', false), 'BranchCode', false);
  assert.deepEqual(d.picked, ['BranchCode']);
  assert.equal(d.other, '');
});

test('typing in Other clears a single-select pick but keeps multi-select picks', () => {
  assert.deepEqual(typeOther(pick(EMPTY_DRAFT, 'BranchCode', false), 'neither', false).picked, []);
  const m = typeOther(pick(EMPTY_DRAFT, 'Lint', true), 'Smoke', true);
  assert.deepEqual(m.picked, ['Lint']);
  assert.equal(m.other, 'Smoke');
});

test('a multi-select pick toggles', () => {
  const d = pick(pick(pick(EMPTY_DRAFT, 'Lint', true), 'Unit', true), 'Lint', true);
  assert.deepEqual(d.picked, ['Unit']);
});

test('answered needs a pick or some Other text', () => {
  assert.equal(answered(EMPTY_DRAFT), false);
  assert.equal(answered(typeOther(EMPTY_DRAFT, '   ', false)), false);
  assert.equal(answered(typeOther(EMPTY_DRAFT, 'mine', false)), true);
  assert.equal(answered(pick(EMPTY_DRAFT, 'Lint', true)), true);
});

test('buildReply sends one string per question, multi-select comma-separated with Other last', () => {
  const reply = buildReply(
    [single, multi],
    [
      pick(EMPTY_DRAFT, 'BranchCode', false),
      typeOther(pick(pick(EMPTY_DRAFT, 'E2E', true), 'Lint', true), ' Smoke ', true),
    ],
  );
  assert.deepEqual(reply, {
    answers: { 'Which Store code?': 'BranchCode', 'Which checks?': 'E2E, Lint, Smoke' },
  });
});

test('buildReply sends Other text in place of a single-select pick', () => {
  assert.deepEqual(buildReply([single], [typeOther(EMPTY_DRAFT, ' Both, by region ', false)]), {
    answers: { 'Which Store code?': 'Both, by region' },
  });
});

test('buildReply carries notes and the chosen preview as annotations, and leaves out empty ones', () => {
  const noted = { ...pick(EMPTY_DRAFT, 'StoreCode', false), notes: ' only for Store forms ' };
  const plain = pick(EMPTY_DRAFT, 'Unit', true);
  assert.deepEqual(buildReply([single, multi], [noted, plain]), {
    answers: { 'Which Store code?': 'StoreCode', 'Which checks?': 'Unit' },
    annotations: { 'Which Store code?': { preview: 'STR01', notes: 'only for Store forms' } },
  });
  assert.deepEqual(buildReply([multi], [{ ...plain, notes: 'and smoke later' }]), {
    answers: { 'Which checks?': 'Unit' },
    annotations: { 'Which checks?': { notes: 'and smoke later' } },
  });
});

test('buildReply sends no preview when Other replaced the pick', () => {
  const reply = buildReply([single], [typeOther(EMPTY_DRAFT, 'neither', false)]);
  assert.equal(reply.annotations, undefined);
});
