import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradeLevel, plainEnglishIssues, syllables } from '../src/shared/plain-english.ts';

test('syllables and grade level land where a reader would expect', () => {
  assert.equal(syllables('form'), 1);
  assert.equal(syllables('number'), 2);
  assert.equal(syllables('customer'), 3);
  assert.ok(gradeLevel('The old form sends the store code. Should the new one do the same?') < 6);
  assert.ok(
    gradeLevel(
      'Notwithstanding the aforementioned considerations, the implementation necessitates reconciliation of heterogeneous identifier semantics.',
    ) > 14,
  );
});

test('a plain product question passes', () => {
  assert.deepEqual(
    plainEnglishIssues(
      'When a shopper picks up an order at a store, which store should the paperwork show?',
      'question',
    ),
    [],
  );
  assert.deepEqual(
    plainEnglishIssues('Today the old app prints the store number where the orders were picked up.'),
    [],
  );
  assert.deepEqual(plainEnglishIssues('Show the delivery store', 'option'), []);
});

test('developer wording is called out, with the words that tripped it', () => {
  const issues = plainEnglishIssues('Should the DTO send storeNumber or BranchCode to the API?', 'question');
  assert.ok(
    issues.some((i) => i.startsWith('no identifiers from the code: storeNumber, BranchCode')),
    issues.join(' | '),
  );
  assert.ok(
    issues.some((i) => i.startsWith('no developer words: dto, api')),
    issues.join(' | '),
  );
  assert.ok(plainEnglishIssues('Use `ORDNO` from the payload?', 'question').some((i) => i.startsWith('no code')));
  assert.ok(
    plainEnglishIssues('Is ORDNO the right field?', 'question').some((i) => i.includes('system field codes: ORDNO')),
  );
  assert.deepEqual(plainEnglishIssues('Is the ERP site number the right one for the PO?', 'question'), []);
});

test('shape rules: a question ends with ?, stays short, and keeps sentences short', () => {
  assert.ok(
    plainEnglishIssues('Which store should it show', 'question').includes('a question ends with a question mark'),
  );
  const long = Array.from({ length: 50 }, () => 'word').join(' ') + '?';
  assert.ok(plainEnglishIssues(long, 'question').some((i) => i.startsWith('too long: 50 words')));
  const runOn = Array.from({ length: 30 }, () => 'and').join(' ') + '.';
  assert.ok(plainEnglishIssues(runOn).some((i) => i.includes('runs past')));
  assert.deepEqual(plainEnglishIssues('', 'question'), ['the question is empty']);
  assert.deepEqual(plainEnglishIssues(''), []);
});

test('product terms are allowed only when the config names them', () => {
  assert.match(plainEnglishIssues('Should the CORE screen show the price?', 'question').join(' '), /CORE/);
  assert.deepEqual(plainEnglishIssues('Should the CORE screen show the price?', 'question', ['CORE']), []);
});
