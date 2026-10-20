import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstProblem, noteGist, stagePips } from './pr-notes.ts';

const long =
  "c7d88f9dbe drops coversTractor/coversBundle (42 deletions). Replied on markyd's thread and re-requested him. " +
  "Tick 842: unit tests green on c7d88f9dbe. NOT resolving markyd's thread while his CHANGES_REQUESTED stands. " +
  'Tick 847: markyd APPROVED at 15:15:40Z, newer than the head. 8/8 green, 0 threads, CLEAN, no content overlap with main (16 behind). ' +
  'gh pr merge was refused by the auto-mode classifier (Merge Without Review), so I did NOT retry or work around it.';

test('noteGist keeps only the newest tick, on one line, cut at a sentence', () => {
  const g = noteGist(long)!;
  assert.ok(g.startsWith('markyd APPROVED at 15:15:40Z'));
  assert.ok(!g.includes('Tick'));
  assert.ok(g.length <= 111, `too long: ${g.length}`);
  assert.ok(g.endsWith('…'));
  assert.ok(g.endsWith('.…') || g.endsWith('…'), 'ends on a sentence boundary or a hard cut');
});

test('noteGist handles notes without ticks, blanks, and short notes', () => {
  assert.equal(noteGist('blocked on A/B/C'), 'blocked on A/B/C');
  assert.equal(noteGist('  one line\n\nwith   spaces '), 'one line with spaces');
  assert.equal(noteGist(null), null);
  assert.equal(noteGist('   '), null);
  assert.equal(noteGist('x'.repeat(200), 50)!.length, 51);
});

test('stagePips keeps the gate order and fills gaps as pending', () => {
  const pips = stagePips({
    review: { state: 'warn', label: 'CHANGES_REQUESTED' },
    ci: { state: 'good', label: '8/8' },
  });
  assert.deepEqual(
    pips.map((p) => [p.key, p.state]),
    [
      ['ci', 'good'],
      ['review', 'warn'],
      ['conflicts', 'pending'],
      ['merge', 'pending'],
    ],
  );
  assert.equal(pips[1].title, 'review: CHANGES_REQUESTED');
  assert.equal(pips[2].title, 'conflicts: pending');
});

test('firstProblem names the first gate that is not green', () => {
  assert.equal(
    firstProblem({
      ci: { state: 'good', label: '' },
      review: { state: 'good', label: '' },
      conflicts: { state: 'good', label: '' },
      merge: { state: 'good', label: '' },
    }),
    null,
  );
  assert.equal(
    firstProblem({
      ci: { state: 'good', label: '' },
      review: { state: 'bad', label: '1 failing' },
    })!.key,
    'review',
  );
});
