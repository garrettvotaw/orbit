import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADO_PALETTE } from '../src/shared/ado-palette.ts';
import {
  STAGE_COLORS,
  adoColumns,
  columnFor,
  stageFromName,
  stageOf,
  withStages,
  type TypeState,
} from '../src/main/trackers/stages.ts';
import type { BoardColumn, TrackerItem } from '../src/shared/types.ts';

const item = (id: string, column: string): TrackerItem => ({
  id,
  key: id,
  title: `story ${id}`,
  type: 'User Story',
  column,
  stage: 'building',
  assignedTo: null,
  parentId: null,
  prs: [],
  url: `https://example.test/${id}`,
  sprint: null,
});

test('stageFromName reads plain column names', () => {
  const cases: Array<[string, string | null]> = [
    ['Code Review', 'in-review'],
    ['Pull Request', 'in-review'],
    ['QA', 'testing'],
    ['Testing', 'testing'],
    ['QA', 'testing'],
    ['Blocked', 'blocked'],
    ['On Hold', 'blocked'],
    ['Done', 'done'],
    ['Closed', 'done'],
    ['To Do', 'not-started'],
    ['Backlog', 'not-started'],
    ['New', 'not-started'],
    ['In Progress', 'building'],
    ['Active', 'building'],
    ['Ready', null],
  ];
  for (const [name, stage] of cases) assert.equal(stageFromName(name), stage, name);
});

test('stageFromName checks blocked, then review, then testing', () => {
  assert.equal(stageFromName('Blocked in Review'), 'blocked');
  assert.equal(stageFromName('Review Testing'), 'in-review');
  assert.equal(stageFromName('Testing Done'), 'testing');
});

test('stageOf: an override beats the name, the name beats the category', () => {
  assert.equal(stageOf('Code Review', 'in-progress'), 'in-review');
  assert.equal(stageOf('Code Review', 'in-progress', { 'Code Review': 'building' }), 'building');
  assert.equal(stageOf('Ready', 'proposed'), 'not-started');
  assert.equal(stageOf('Ready', null), 'building');
});

test('stageOf falls back on the category', () => {
  assert.equal(stageOf('Ready', 'proposed'), 'not-started');
  assert.equal(stageOf('Ready', 'in-progress'), 'building');
  assert.equal(stageOf('Ready', 'resolved'), 'testing');
  assert.equal(stageOf('Ready', 'completed'), 'done');
  assert.equal(stageOf('Ready', 'removed'), 'done');
});

test('columnFor returns the first column with the stage, else null', () => {
  const columns: BoardColumn[] = [
    { name: 'To Do', stage: 'not-started', color: '#1' },
    { name: 'Doing', stage: 'building', color: '#2' },
    { name: 'Pairing', stage: 'building', color: '#3' },
  ];
  assert.equal(columnFor('building', columns)?.name, 'Doing');
  assert.equal(columnFor('testing', columns), null);
});

test('withStages sets each item from its column, and from stageOf for a column the board does not list', () => {
  const columns: BoardColumn[] = [{ name: 'Ready', stage: 'not-started', color: '#1' }];
  const out = withStages([item('1', 'Ready'), item('2', 'Code Review'), item('3', 'Mystery')], columns, {
    Mystery: 'blocked',
  });
  assert.deepEqual(
    out.map((i) => i.stage),
    ['not-started', 'in-review', 'blocked'],
  );
});

test('adoColumns keeps the palette order and colours, then adds unlisted states in first-seen order', () => {
  const types: TypeState[][] = [
    [
      { name: 'Active', category: 'in-progress', color: '007acc' },
      { name: 'Resolved', category: 'resolved', color: 'ff9d00' },
    ],
    [
      { name: 'Resolved', category: 'resolved', color: 'ff9d00' },
      { name: 'Approved', category: 'proposed', color: null },
    ],
  ];
  const cols = adoColumns(types);
  assert.deepEqual(
    cols.slice(0, ADO_PALETTE.length).map((c) => [c.name, c.color]),
    ADO_PALETTE.map((p) => [p.name, p.color]),
  );
  const active = cols.find((c) => c.name === 'Active');
  assert.deepEqual(active, { name: 'Active', stage: 'building', color: '#2fb344' });
  assert.deepEqual(cols.slice(ADO_PALETTE.length), [
    { name: 'Resolved', stage: 'testing', color: '#ff9d00' },
    { name: 'Approved', stage: 'not-started', color: STAGE_COLORS['not-started'] },
  ]);
});

test('adoColumns stages a palette state from the API category when the name does not say', () => {
  const plain = ADO_PALETTE.find((p) => stageFromName(p.name) === null);
  assert.ok(plain, 'the palette has a state whose name says nothing');
  const cols = adoColumns([[{ name: plain.name, category: 'proposed', color: null }]]);
  assert.equal(cols.find((c) => c.name === plain.name)?.stage, 'not-started');
});

test('the palette is the ladder the ring has always drawn, every state in its own colour', () => {
  assert.equal(ADO_PALETTE.length, 19);
  assert.deepEqual(ADO_PALETTE[0], { name: 'New', color: '#64748b' });
  const colors = ADO_PALETTE.map((p) => p.color);
  assert.equal(new Set(colors).size, colors.length);
});

test('STAGE_COLORS', () => {
  assert.deepEqual(STAGE_COLORS, {
    'not-started': '#64748b',
    building: '#2fb344',
    'in-review': '#a78bfa',
    testing: '#f59e0b',
    done: '#059669',
    blocked: '#ef4444',
  });
});
