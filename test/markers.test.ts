import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/main/db.ts';
import { MarkerStore } from '../src/main/trackers/markers.ts';

test('MarkerStore remembers a comment per tracker, story, and marker, and forgets on request', () => {
  const store = new MarkerStore(openDb(':memory:'));
  const contoso = store.for({ kind: 'ado', site: 'contoso' });
  const fabrikam = store.for({ kind: 'ado', site: 'fabrikam' });
  assert.equal(contoso.get('1301', 'plan'), null);
  contoso.set('1301', 'plan', '12');
  contoso.set('1301', 'status', '14');
  assert.equal(contoso.get('1301', 'plan'), '12');
  assert.equal(contoso.get('1302', 'plan'), null, 'another story');
  assert.equal(fabrikam.get('1301', 'plan'), null, 'another org');
  contoso.set('1301', 'plan', '13');
  assert.equal(contoso.get('1301', 'plan'), '13', 'a new comment replaces the old one');
  contoso.forget('1301', 'plan');
  assert.equal(contoso.get('1301', 'plan'), null);
  assert.equal(contoso.get('1301', 'status'), '14');
});
