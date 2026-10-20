import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boardGroups,
  isStale,
  mentionsKey,
  prGroups,
  prSummary,
  ringDots,
  ringSegments,
  stageLayout,
} from './ring.ts';
import type { BoardColumn, PrLane, TrackerBoard, TrackerItem } from '../../../../shared/types.ts';

const item = (id: number, column: string): TrackerItem => ({
  id: String(id),
  key: String(id),
  title: `Story ${id}`,
  type: 'User Story',
  column,
  stage: 'building',
  assignedTo: null,
  parentId: null,
  prs: [],
  url: `https://tracker/${id}`,
  sprint: null,
});

/** A board's ladder as main hands it over: its columns in board order, each in its own colour. */
const LADDER: BoardColumn[] = (
  [
    ['New', '#64748b'],
    ['Ready', '#14b8a6'],
    ['Active', '#2fb344'],
    ['QA/Staging', '#f97316'],
    ['Ready to Test', '#ec4899'],
    ['Verifying', '#a855f7'],
    ['Owner Review', '#3b82f6'],
    ['Ready to Release', '#84cc16'],
  ] as const
).map(([name, color]) => ({ name, stage: 'building', color }));
const board = (items: TrackerItem[], columns: BoardColumn[] = LADDER): TrackerBoard => ({
  projectId: 'shop',
  tracker: { kind: 'ado', site: 'contoso' },
  fetchedAt: 1,
  columns,
  items,
  stale: false,
  error: null,
});

test('boardGroups follows the board column order and colours, keys items by column, and drops empty columns', () => {
  const columns: BoardColumn[] = [
    { name: 'To Do', stage: 'not-started', color: '#111111' },
    { name: 'Doing', stage: 'building', color: '#222222' },
    { name: 'Review', stage: 'in-review', color: '#333333' },
  ];
  const g = boardGroups(board([item(1, 'Review'), item(2, 'To Do'), item(3, 'Review')], columns));
  assert.deepEqual(
    g.map((x) => [x.key, x.label, x.color, x.items.length]),
    [
      ['To Do', 'To Do', '#111111', 1],
      ['Review', 'Review', '#333333', 2],
    ],
  );
  assert.deepEqual(boardGroups(null), []);
});

test('boardGroups keeps the ladder order and shows unknown states by their real name after it, in grey', () => {
  const g = boardGroups(
    board([
      item(1, 'Owner Review'),
      item(2, 'Weird'),
      item(3, 'New'),
      item(4, 'Odd'),
      item(5, 'Weird'),
      item(6, 'New'),
    ]),
  );
  assert.deepEqual(
    g.map((x) => [x.key, x.label, x.items.length]),
    [
      ['New', 'New', 2],
      ['Owner Review', 'Owner Review', 1],
      ['Weird', 'Weird', 2],
      ['Odd', 'Odd', 1],
    ],
  );
  assert.equal(g[2].color, '#9aa3b2');
  assert.equal(g[3].color, '#9aa3b2');
});

test('boardGroups orders a second board along the same ladder, every state in its own colour', () => {
  const g = boardGroups(
    board([
      item(1, 'Ready to Release'),
      item(2, 'Verifying'),
      item(3, 'Ready to Test'),
      item(4, 'QA/Staging'),
      item(5, 'Ready'),
    ]),
  );
  assert.deepEqual(
    g.map((x) => x.key),
    ['Ready', 'QA/Staging', 'Ready to Test', 'Verifying', 'Ready to Release'],
  );
  for (const x of g) assert.notEqual(x.color, '#9aa3b2', `${x.key} has its own colour`);
});

test('ringSegments covers the circle with gaps and sequential offsets', () => {
  const r = 50;
  const circ = 2 * Math.PI * r;
  const segs = ringSegments(
    boardGroups(
      board([item(1, 'New'), item(2, 'New'), item(3, 'Active'), item(4, 'Owner Review')]),
    ),
    r,
    4,
  );
  assert.equal(segs.length, 3);
  assert.ok(Math.abs(segs[0].length - (circ / 2 - 4)) < 0.01);
  assert.equal(segs[0].start, 2);
  assert.ok(Math.abs(segs[1].start - (circ / 2 + 2)) < 0.01);
  assert.match(segs[0].dasharray, /^\d+\.\d\d \d+\.\d\d$/);
  assert.equal(segs[0].dashoffset, -2);
  assert.deepEqual(ringSegments([], r), []);
});

test('ringDots places items inside their own segment starting at 12 o clock', () => {
  const r = 100;
  const groups = boardGroups(board([item(1, 'New'), item(2, 'Active')]));
  const segs = ringSegments(groups, r, 0);
  const dots = ringDots(groups, segs, r, (i) => ({ id: i.id, title: i.title, url: i.url }));
  assert.equal(dots.length, 2);
  assert.ok(dots[0].x > 0 && Math.abs(dots[0].y) < 1, 'first segment midpoint is at 3 o clock');
  assert.ok(dots[1].x < 0 && Math.abs(dots[1].y) < 1, 'second segment midpoint is at 9 o clock');
  assert.equal(dots[0].color, LADDER[0].color);
});

const lane = (n: number, bucket: string): PrLane => ({
  number: n,
  title: '',
  story: null,
  bucket,
  status: '',
  note: null,
  url: '',
  stages: {},
});

test('prGroups hides merged and buckets the rest', () => {
  const g = prGroups([
    lane(1, 'merged'),
    lane(2, 'fixing'),
    lane(3, 'waiting'),
    lane(4, 'waiting'),
  ]);
  assert.deepEqual(
    g.map((x) => [x.key, x.items.length]),
    [
      ['fixing', 1],
      ['waiting', 2],
    ],
  );
});

test("prGroups knows the monitor's ready and attention, puts what needs you first, and capitalises buckets it does not know", () => {
  const g = prGroups([
    lane(1, 'parked'),
    lane(2, 'attention'),
    lane(3, 'closed'),
    lane(4, 'ready'),
    lane(5, 'parked'),
  ]);
  assert.deepEqual(
    g.map((x) => [x.key, x.label, x.items.length]),
    [
      ['attention', 'Needs you', 1],
      ['ready', 'Ready', 1],
      ['parked', 'Parked', 2],
    ],
  );
  assert.equal(g[2].color, '#9aa3b2');
  assert.notEqual(g[0].color, '#9aa3b2');
  assert.notEqual(g[1].color, '#9aa3b2');
});

test('prSummary names each bucket that has PRs by its real name, and leaves merged and closed out', () => {
  assert.equal(
    prSummary([
      lane(1, 'merged'),
      lane(2, 'closed'),
      lane(3, 'waiting'),
      lane(4, 'attention'),
      lane(5, 'waiting'),
      lane(6, 'ready'),
      lane(7, 'parked'),
    ]),
    '5 open · needs you 1 · ready 1 · waiting on review 2 · parked 1',
  );
  assert.equal(prSummary([lane(1, 'merged')]), '0 open');
});

test('stageLayout spreads at home and focuses one core in the lane view', () => {
  const home = stageLayout(3, null, false, 1200, 800);
  assert.deepEqual(
    home.map((p) => p.x),
    [300, 600, 900],
  );
  const focused = stageLayout(3, 1, false, 1200, 800);
  assert.equal(focused[1].scale, 1.7);
  assert.equal(focused[1].x, 336);
  assert.deepEqual([focused[0].x, focused[2].x], [56, 128]);
  assert.equal(stageLayout(3, 1, true, 1200, 800)[1].x, 204, 'board open pushes the orbit left');
});

test('isStale only for idle lanes quiet for two hours', () => {
  const h = 60 * 60_000;
  assert.equal(isStale('idle', 0, null, 3 * h), true);
  assert.equal(isStale('idle', 0, 2 * h, 3 * h), false);
  assert.equal(isStale('working', 0, null, 3 * h), false);
  assert.equal(isStale('idle', null, null, 3 * h), false);
});

test('stageLayout places lanes by slot when given one', () => {
  const home = stageLayout(3, null, false, 1200, 800, [2, 0, 1]);
  assert.deepEqual(
    home.map((p) => p.x),
    [900, 300, 600],
  );
  assert.deepEqual(
    stageLayout(3, null, false, 1200, 800).map((p) => p.x),
    [300, 600, 900],
  );
});

test("stageLayout parks lanes far enough apart that one PM's moons never reach the next", () => {
  // Lanes 0 and 2 have moons reaching 170px at full size; lane 3 is a plain core.
  const reach = [170, 84, 170, 84];
  const parked = stageLayout(4, 1, false, 1200, 800, [0, 1, 2, 3], reach).filter(
    (p) => p.scale < 1,
  );
  for (let k = 0; k + 1 < parked.length; k++) {
    const [a, b] = [parked[k], parked[k + 1]];
    assert.ok(b.x - a.x >= 72);
  }
  const [first, second] = parked;
  assert.ok(second.x - first.x >= (170 + 170) * first.scale - 1, 'two moon rings side by side');
  assert.deepEqual(
    stageLayout(3, 1, false, 1200, 800, [0, 1, 2], [0, 0, 0])
      .filter((p) => p.scale < 1)
      .map((p) => p.x),
    [56, 128],
    'small lanes keep the usual spacing',
  );
});

test('mentionsKey matches a story key only as a whole token', () => {
  assert.ok(mentionsKey('building 100122 now', '100122'));
  assert.ok(!mentionsKey('building 1001221 now', '100122'));
  assert.ok(mentionsKey('angular · ACME-12: wire it', 'ACME-12'));
  assert.ok(!mentionsKey('ACME-123 is next', 'ACME-12'));
  assert.ok(mentionsKey('fixing #45, then lint', '#45'));
  assert.ok(!mentionsKey('fixing #456', '#45'));
});

test('mentionsKey finds a key beside punctuation: AB# prefixes and branch slugs', () => {
  assert.ok(mentionsKey('angular · AB#100122 wiring', '100122'));
  assert.ok(mentionsKey('users/pat/ACME-12-saved-cards', 'ACME-12'));
});
