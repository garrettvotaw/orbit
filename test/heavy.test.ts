import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heavyLabel } from '../src/main/heavy.ts';

test('heavy commands get a short label', () => {
  const rows: Array<[string, string]> = [
    ['npx nx affected -t test lint --base=origin/main', 'nx affected'],
    ['cd libs/a && npx nx test wo-client', 'nx test'],
    ['npx nx run wo-client:lint', 'nx lint'],
    ['npx nx run-many -t test --all', 'nx run-many'],
    ['nx build wo-client --configuration=production', 'nx build'],
    ['npx nx e2e wo-client-e2e', 'nx e2e'],
    ['npx jest src/x.spec.ts', 'jest'],
    ['npx vitest run', 'vitest'],
    ['npx playwright test -c e2e/playwright.config.ts', 'playwright'],
    ['npx ng test', 'ng test'],
    ['ng build', 'ng build'],
    ['npm test', 'npm test'],
    ['npm run test:unit', 'npm test:unit'],
    ['npm run e2e', 'npm e2e'],
    ['npm --prefix src/renderer run build', 'npm build'],
    ['git status; npx nx test wo-client 2>&1 | tail -40', 'nx test'],
  ];
  for (const [command, label] of rows) assert.equal(heavyLabel(command), label, command);
});

test('light and long-running commands are not heavy', () => {
  const rows = [
    'npx nx serve wo-client',
    'npx nx test a --watch',
    'npx nx show projects',
    'npx nx graph',
    'npx nx reset',
    'git status',
    'ls nx-test',
    'npm install',
    'npm run start',
    'npx ng serve',
    'cat jest.config.ts',
    'npm run test:watch',
    'npx jest --watchAll',
    'npx playwright test --ui',
  ];
  for (const command of rows) assert.equal(heavyLabel(command), null, command);
});

test('timeout, time, env, nice, and bash -c in front still count', () => {
  const rows: Array<[string, string]> = [
    ['timeout 900 npx nx affected -t test', 'nx affected'],
    ['time npx jest', 'jest'],
    ['env CI=true npx jest', 'jest'],
    ['nice -n 10 npx nx test a', 'nx test'],
    ['bash -c "npx nx test x"', 'nx test'],
    ["sh -c 'cd libs/a && npm test'", 'npm test'],
  ];
  for (const [command, label] of rows) assert.equal(heavyLabel(command), label, command);
});
