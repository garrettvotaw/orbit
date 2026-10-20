import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../src/main/db.ts';
import { SecretStore, jiraSecretKey, type SecretCodec } from '../src/main/secrets.ts';

/** Reversible and visibly not the plain text, so a test can tell what was stored. */
const codec: SecretCodec = {
  encrypt: (plain) => `enc:${Buffer.from(plain).toString('base64')}`,
  decrypt: (stored) => Buffer.from(stored.replace(/^enc:/, ''), 'base64').toString(),
};

const db = () => openDb(path.join(mkdtempSync(path.join(tmpdir(), 'orbit-secrets-')), 'orbit.db'));

test('set then get round-trips through the codec', () => {
  const store = new SecretStore(db(), codec);
  store.set('jira:contoso.atlassian.net', '{"email":"pat@contoso.test","token":"t0k"}');
  assert.equal(store.get('jira:contoso.atlassian.net'), '{"email":"pat@contoso.test","token":"t0k"}');
  assert.equal(store.get('jira:other.atlassian.net'), null);
});

test('the stored row is the codec output, never the plain value', () => {
  const d = db();
  new SecretStore(d, codec).set('k', 'plain-token');
  const row = d.prepare('SELECT value FROM secrets WHERE key = ?').get('k') as { value: string };
  assert.equal(row.value, codec.encrypt('plain-token'));
  assert.ok(!row.value.includes('plain-token'));
});

test('set replaces and delete removes', () => {
  const store = new SecretStore(db(), codec);
  store.set('k', 'one');
  store.set('k', 'two');
  assert.equal(store.get('k'), 'two');
  store.delete('k');
  assert.equal(store.get('k'), null);
});

test('jiraSecretKey names the site', () => {
  assert.equal(jiraSecretKey('contoso.atlassian.net'), 'jira:contoso.atlassian.net');
});
