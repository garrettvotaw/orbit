import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let app: ElectronApplication;
let page: Page;

/** The folder the e2e config's one project lives in: this repo, so it exists on any machine. */
const REPO = path.resolve('.');

/** A config of the e2e's own, so a run never reads (or depends on) the real ~/.claude/orbit/config.json. */
function e2eConfig(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-e2e-'));
  const file = path.join(dir, 'config.json');
  const project = { id: 'shop', name: 'Storefront', agent: 'shop-pm', cwd: REPO, kickoff: 'Run the board.' };
  const monitor = {
    id: 'prs',
    name: 'PR Monitor',
    skill: 'monitor-prs',
    cwd: REPO,
    everyMinutes: 60,
    stateFile: path.join(dir, 'state.json'),
  };
  // The fixture's PR monitor is stopped, so Morning start has something to start.
  const config = { projects: [project], monitors: [monitor], chats: [], morning: ['shop', 'prs'] };
  writeFileSync(file, JSON.stringify(config));
  return file;
}

/** Launch Orbit on a fixture and wait for the home row to render. */
async function launch(fixture: string): Promise<void> {
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, ORBIT_FIXTURE: fixture, ORBIT_CONFIG: e2eConfig() },
  });
  page = await app.firstWindow();
  await page.getByRole('banner').waitFor();
}

test.beforeEach(async () => {
  await launch(path.resolve('e2e/fixture-snapshot.json'));
});

test.afterEach(async () => {
  await app.close();
});

test('home renders cores and the question card from a fixture', async () => {
  await expect(page.getByRole('banner')).toContainText('Orbit');
  await expect(page.getByRole('banner')).toContainText('2 need you');
  // Today's total is what finished turns spent plus every turn still running (a story moon's too), hence the ~.
  await expect(page.getByRole('banner')).toContainText('today ~$13.00');
  await expect(page.getByText('$4.12 +~$0.42')).toBeVisible();
  await expect(page.getByText('$1.90 · ', { exact: false })).toBeVisible();
  expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu() === null)).toBe(true);
  await expect(page.getByRole('button', { name: 'Open Storefront' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Cart' })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Something needs you' })).toBeVisible();
  await expect(page.getByText('Which Store code should the form send?')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Answer' })).toBeDisabled();
  await page.getByLabel('StoreCode', { exact: false }).check();
  await expect(page.getByRole('button', { name: 'Answer' })).toBeEnabled();
  await page.getByRole('button', { name: 'Open Storefront' }).click();
  await expect(page.getByRole('heading', { name: 'Storefront' })).toBeVisible();
  await expect(page.getByText('working · $4.12 +~$0.42')).toBeVisible();
  await expect(page.getByLabel('Message to Storefront')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Morning start' })).toBeEnabled();
  const endDay = page.getByRole('button', { name: 'End the day' });
  await expect(endDay).toBeEnabled();
  await endDay.click();
  await expect(page.locator('.sunset')).toHaveCount(1);
  await page.waitForTimeout(800); // let the lanes finish moving before the picture
  await page.screenshot({ path: 'e2e/.tmp/home.png' });
});

test('every core speaks: the PM bubble shows a handoff or what it last said, and the legend lists the agents on stage', async () => {
  const shop = page.getByRole('note', { name: 'Storefront says' });
  await expect(shop).toContainText('→ angular');
  await expect(shop).toContainText('type change clears steps');
  const cart = page.getByRole('note', { name: 'Cart says' });
  await expect(cart).toContainText('The Store form needs a code');
  await expect(page.getByRole('note', { name: 'PR Monitor says' })).toHaveCount(0);

  const legend = page.getByLabel('Legend');
  await expect(legend).toContainText('angular');
  await expect(legend).toContainText('architect');
  await expect(legend).toContainText('debugger');
  // Agent entries wear a glyph in their color; status and ring entries remain plain swatches.
  const swatches = await legend.evaluate((el) =>
    Array.from(el.querySelectorAll('i.glyph')).map((i) => [
      i.nextSibling?.textContent?.trim(),
      i.style.color,
      i.textContent?.trim(),
    ]),
  );
  const byName = Object.fromEntries(swatches.map(([n, c, g]) => [n, { c, g }]));
  expect(byName['debugger'].c).toBe('rgb(250, 204, 21)');
  expect(byName['debugger'].g).toBe('!?');
  expect(byName['angular'].g).toBe('</>');
  expect(byName['architect'].c).not.toBe('rgb(154, 163, 178)');
  expect(byName['architect'].c).toMatch(/^rgb\(/);
  await page.waitForTimeout(800); // let the bubbles finish rising before the picture
  await page.screenshot({ path: 'e2e/.tmp/bubbles.png' });
});

test('lane view shows satellites, the report line, the board, and an agent transcript', async () => {
  await page.getByRole('button', { name: 'Open Storefront' }).click();

  const agents = page.getByRole('list', { name: 'Agents' });
  await expect(agents.getByRole('listitem')).toHaveCount(3);
  await expect(agents.getByText('writing shopper-step.spec')).toBeVisible();

  const report = page.getByLabel('Last board report');
  await expect(report).toContainText('Shipped 2');
  await expect(report).toContainText('Blocked 1');
  await expect(report).toContainText('Next: 100203');

  await expect(page.getByRole('link', { name: '100180 Blank subscription shows customer profile pics' })).toBeVisible();

  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await expect(page.getByLabel('Pull Request column')).toContainText('100180');
  await expect(page.getByLabel('New column')).toContainText('100203');
  await expect(page.getByLabel('Owner Review column')).toContainText('100143');
  await page.waitForTimeout(800); // let the lanes finish moving before the picture
  await page.screenshot({ path: 'e2e/.tmp/lane-board.png' });

  await agents.getByRole('listitem', { name: /angular · type change clears steps/ }).click();
  const log = page.getByRole('log', { name: /Transcript for angular/ });
  await expect(log).toContainText('Writing the failing spec first.');
  await expect(log).toContainText('Edit shopper-step.spec.ts');

  // A long transcript opens at its newest line, holds your place when you scroll up to read, and
  // follows the tail again once you return to the bottom.
  const scroll = () =>
    log.evaluate((el) => ({ top: el.scrollTop, gap: el.scrollHeight - el.scrollTop - el.clientHeight }));
  await expect.poll(async () => (await scroll()).gap).toBeLessThan(2);
  await log.evaluate((el) => (el.scrollTop = 0));
  await log.getByText('Bash result').click();
  await expect(log).toContainText('Tests: 1 failed, 123 passed');
  await page.screenshot({ path: 'e2e/.tmp/lane-drawer.png' });
  const before = await scroll();
  expect(before.gap).toBeGreaterThan(200);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  expect((await scroll()).top).toBe(before.top);
  await log.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect.poll(async () => (await scroll()).gap).toBeLessThan(2);

  await page.getByRole('button', { name: 'Close transcript' }).click();
  await page.getByRole('button', { name: 'Transcript', exact: true }).click();
  await expect(page.getByRole('log', { name: /Transcript for Storefront · PM/ })).toContainText('Deriving the board');
});

test('monitor lane shows the PR ring, the PR table, and hides merged PRs', async () => {
  await page.getByRole('button', { name: 'Open PR Monitor' }).click();
  await expect(page.getByRole('heading', { name: 'PR Monitor' })).toBeVisible();
  await expect(page.getByLabel('Last board report')).toContainText('3 open');
  await expect(page.getByRole('link', { name: '#7117 Bundle-only visit seeds bundle' })).toBeVisible();
  await expect(page.getByRole('link', { name: /#7101/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'Board', exact: true }).click();
  const table = page.getByRole('table', { name: 'Pull requests' });
  await expect(table.getByRole('row')).toHaveCount(4);
  const row = table.getByRole('row').filter({ hasText: '#7117' });
  await expect(row.getByRole('img', { name: /ci: unit tests red/ })).toBeVisible();
  await expect(row).toContainText('ci: unit tests red');
  await expect(row).toContainText('Pat picked C; fixer resumed');
  await expect(table.getByText(/Tick 1154/)).toHaveCount(0);
  await row.getByRole('button', { name: 'full note' }).click();
  await expect(table.getByText(/Tick 1154/)).toBeVisible();
  await row.getByRole('button', { name: 'hide note' }).click();
  await expect(table.getByText(/Tick 1154/)).toHaveCount(0);
  await expect(table.getByRole('row').filter({ hasText: '#7120' })).toContainText('all green');
  await expect(table).not.toContainText('#7101');
  await expect(page.getByText('Tick 1155: no change.')).toBeVisible();
  await page.screenshot({ path: 'e2e/.tmp/monitor-board.png' });
});

test('stale board shows the stale notice', async () => {
  await page.getByRole('button', { name: 'Open Cart' }).click();
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await expect(page.getByText(/Board is stale \(ADO 401/)).toBeVisible();
});

test('a chat lane shows its conversation, a model picker, and an Enter-to-send composer', async () => {
  await page.getByRole('button', { name: 'Open Ask Claude' }).click();
  await expect(page.getByRole('heading', { name: 'Ask Claude' })).toBeVisible();
  const log = page.getByRole('log', { name: 'Conversation with Ask Claude' });
  await expect(log).toContainText('What does the cart grid page size default to?');
  await expect(log).toContainText('Grep pageSize in libs');
  await expect(log).toContainText('It defaults to 25 rows');
  // The assistant's markdown renders as markup: bold, inline code, a list, a link.
  await expect(log.locator('strong', { hasText: '25 rows' })).toBeVisible();
  await expect(log.locator('code', { hasText: 'DEFAULT_PAGE_SIZE = 25' })).toBeVisible();
  await expect(log.getByRole('listitem')).toHaveCount(2);
  await expect(log).not.toContainText('**25 rows**');
  await expect(log).not.toContainText('](https://');
  const link = log.getByRole('link', { name: 'cart-grid.config.ts' });
  await expect(link).toBeVisible();
  const opened: string[] = [];
  await app.evaluate(({ shell }) => {
    (globalThis as unknown as { __opened: string[] }).__opened = [];
    shell.openExternal = async (url: string) => {
      (globalThis as unknown as { __opened: string[] }).__opened.push(url);
    };
  });
  await link.click();
  await expect
    .poll(async () => {
      opened.splice(
        0,
        opened.length,
        ...(await app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)),
      );
      return opened;
    })
    .toEqual(['https://github.com/contoso/storefront/blob/main/libs/cart-grid.config.ts']);
  await expect(page.getByRole('heading', { name: 'Ask Claude' })).toBeVisible();
  expect(page.url()).toMatch(/^file:/);
  await expect(page.getByRole('button', { name: 'Board', exact: true })).toHaveCount(0);
  const model = page.getByLabel('Model', { exact: true });
  await expect(model).toHaveValue('sonnet');
  await expect(model.locator('option', { hasText: 'fable (alias)' })).toHaveCount(1);
  await expect(model.locator('option', { hasText: 'CLI default' })).toHaveCount(1);
  const box = page.getByLabel('Message to Ask Claude');
  await expect(box).toHaveAttribute('placeholder', /Enter sends/);
  await box.fill('hello');
  await box.press('Enter');
  await expect(box).toHaveValue('');
  await page.screenshot({ path: 'e2e/.tmp/chat.png' });
});

test('New orbit opens a form that needs a name, and an agent for a project', async () => {
  await page.getByRole('button', { name: 'New orbit' }).click();
  const form = page.getByRole('form', { name: 'New orbit' });
  await expect(form).toBeVisible();
  const create = form.getByRole('button', { name: 'Create' });
  await expect(create).toBeDisabled();
  await expect(form.getByLabel('Folder', { exact: true })).toHaveValue(REPO);
  await form.getByLabel('Name', { exact: true }).fill('Quick questions');
  await expect(create).toBeEnabled();

  await form.getByLabel('Project PM', { exact: false }).check();
  await expect(create).toBeDisabled();
  const agent = form.getByLabel('Agent', { exact: true });
  await expect(agent.locator('option', { hasText: 'shop-pm' })).toHaveCount(1);
  await expect(agent.locator('option', { hasText: 'cart-pm' })).toHaveCount(1);
  await agent.selectOption('shop-pm');
  await expect(form.getByLabel('Kickoff', { exact: true })).toHaveValue('Run the board.');
  await expect(create).toBeEnabled();
  await expect(form.getByLabel('Model', { exact: true }).locator('option', { hasText: 'fable (alias)' })).toHaveCount(
    1,
  );
  await page.screenshot({ path: 'e2e/.tmp/new-orbit.png' });
  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(form).toHaveCount(0);
});

test('Reviews lists the team PRs with what needs eyes first and opens a running review', async () => {
  await page.getByRole('button', { name: /^Reviews/ }).click();
  const list = page.getByRole('list', { name: 'Team pull requests' });
  const items = list.getByRole('listitem');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText('#7116');
  await expect(items.nth(0)).toContainText('asked for your review');
  await expect(items.nth(0)).toContainText('changes requested');
  await expect(items.nth(0)).toContainText('CI red');
  await expect(items.nth(0).getByRole('button', { name: 'Review' })).toBeVisible();
  await expect(items.nth(1)).toContainText('team review requested');
  await expect(items.nth(1).getByRole('button', { name: /Open review · idle/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Reviews · 1/ })).toBeVisible();
  const reviewModel = page.getByLabel('Review with', { exact: true });
  await expect(reviewModel.locator('option', { hasText: 'CLI default' })).toHaveCount(1);
  await expect(reviewModel.locator('option', { hasText: 'fable (alias)' })).toHaveCount(1);
  await page.screenshot({ path: 'e2e/.tmp/reviews.png' });

  await items
    .nth(1)
    .getByRole('button', { name: /Open review/ })
    .click();
  await expect(page.getByRole('heading', { name: '#7127 review', exact: true })).toBeVisible();
  await expect(page.getByText('Reviewing')).toBeVisible();
  const log = page.getByRole('log', { name: 'Conversation with #7127 review' });
  await expect(log).toContainText('/review-pr 7127');
  await expect(log).toContainText('Remove any comments by number');
  await expect(page.getByLabel('Message to #7127 review')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open #7127 review' })).toBeVisible();

  const actions = page.getByRole('group', { name: 'Review actions' });
  await expect(actions.getByRole('checkbox')).toHaveCount(12);
  await expect(actions).toContainText('12 of 12 comments will be posted');
  const approve = actions.getByRole('button', { name: 'Approve' });
  // This preview predates comment text, so Orbit cannot post it and the pick goes to Claude.
  await expect(approve).toHaveAttribute(
    'title',
    'Sends to Claude: Post all comments. Approve. (Comment 1 has no text for Orbit to post.)',
  );
  // A long list scrolls inside the bar; the decision buttons and the composer stay on screen.
  await expect(approve).toBeInViewport();
  await expect(page.getByLabel('Message to #7127 review')).toBeInViewport();
  const chips = actions.getByRole('checkbox', { name: /12\. / });
  await expect(chips).not.toBeInViewport();
  await chips.scrollIntoViewIfNeeded();
  await expect(chips).toBeInViewport();
  await actions.getByRole('checkbox', { name: /2\. .*return\.component\.ts:112/ }).uncheck();
  await expect(actions).toContainText('11 of 12 comments will be posted');
  await expect(approve).toHaveAttribute(
    'title',
    'Sends to Claude: Drop comment 2 and post the rest. Approve. (Comment 1 has no text for Orbit to post.)',
  );
  await expect(actions.getByRole('button', { name: 'Request changes' })).toHaveAttribute(
    'title',
    'Sends to Claude: Drop comment 2 and post the rest. Request changes. (Comment 1 has no text for Orbit to post.)',
  );
  await expect(actions.getByRole('button', { name: 'Comment only' })).toBeVisible();
  await page.screenshot({ path: 'e2e/.tmp/review-lane.png' });
  await approve.click();
});

test('a review with comment text is posted by Orbit: the buttons say so, a refusal offers Claude, and a post shows what landed', async () => {
  const base = JSON.parse(readFileSync(path.resolve('e2e/fixture-snapshot.json'), 'utf8')) as {
    lanes: Array<{ id: string; reviewPrompt: { findings: Array<{ gist: string }> } | null }>;
  };
  const lanes = base.lanes.map((l) =>
    l.reviewPrompt
      ? { ...l, reviewPrompt: { findings: l.reviewPrompt.findings.map((f) => ({ ...f, body: `${f.gist} Details.` })) } }
      : l,
  );
  const review = lanes.find((l) => l.reviewPrompt)!;
  const show = (snapshot: unknown) =>
    app.evaluate(({ BrowserWindow }, s) => {
      BrowserWindow.getAllWindows()[0].webContents.send('orbit:event', { type: 'snapshot', snapshot: s });
    }, snapshot);
  const withLane = (patch: Record<string, unknown>) => ({
    ...base,
    lanes: lanes.map((l) => (l.id === review.id ? { ...l, ...patch } : l)),
  });
  await show(withLane({}));

  await page.getByRole('button', { name: 'Open #7127 review' }).click();
  const actions = page.getByRole('group', { name: 'Review actions' });
  const approve = actions.getByRole('button', { name: 'Approve' });
  await expect(approve).toHaveAttribute('title', 'Posts 12 comments and approves');
  await actions.getByRole('checkbox', { name: /2\. .*return\.component\.ts:112/ }).uncheck();
  await expect(approve).toHaveAttribute('title', 'Posts 11 comments and approves');
  // The click goes to Orbit, not the conversation; the buttons hold until GitHub answers.
  await approve.click();
  await expect(approve).toBeDisabled();
  const log = page.getByRole('log', { name: 'Conversation with #7127 review' });
  await expect(log).not.toContainText('Drop comment 2 and post the rest. Approve.');

  await show(
    withLane({
      reviewResult: { ok: false, at: 1, pick: 'approve', error: 'gh: Unprocessable Entity (HTTP 422)' },
    }),
  );
  await expect(actions.getByRole('alert')).toContainText(
    'GitHub did not take the review: gh: Unprocessable Entity (HTTP 422)',
  );
  await expect(actions.getByRole('button', { name: 'Let Claude post it' })).toBeVisible();
  await expect(approve).toBeEnabled();

  await show(
    withLane({
      reviewPrompt: null,
      reviewResult: {
        ok: true,
        at: 2,
        event: 'APPROVE',
        comments: 11,
        url: 'https://github.com/o/r/pull/7127#pullrequestreview-1',
      },
    }),
  );
  await expect(actions).toHaveCount(0);
  const posted = page.getByRole('status', { name: 'Review posted' });
  await expect(posted).toContainText('Posted · approved · 11 comments');
  await expect(posted.getByRole('button', { name: 'View on GitHub' })).toBeVisible();
});

test('a PM that stopped to ask reads like a review: your turn on the core, its words and one-click answers in the panel', async () => {
  // The cart question card is older, so the PM shows up as the second chip on the rail.
  await expect(page.getByRole('status', { name: 'Something needs you' })).toBeVisible();
  await expect(page.getByText('Store Returns · blocked')).toBeVisible();
  const core = page.getByRole('button', { name: 'Open Store Returns' });
  // The planet keeps its own colours; the status shows in the glow around its rim.
  await expect(page.locator('g[orbit-lane-core]', { has: core }).locator('circle.rim')).toHaveAttribute(
    'stroke',
    '#f59e0b',
  );
  await expect(page.locator('g.lane', { has: core })).toContainText('your turn');

  await core.click();
  const said = page.getByRole('note', { name: 'What Store Returns last said' });
  await expect(said).toContainText('Which should the delivery form send?');
  await expect(said.locator('strong', { hasText: 'StoreCode' })).toBeVisible();
  await expect(said.getByRole('listitem')).toHaveCount(3);

  const answer = page.getByRole('group', { name: 'Answer' });
  await expect(answer).toContainText('Pick one, or reply below');
  const buttons = answer.getByRole('button');
  await expect(buttons).toHaveText(['StoreCode', 'BranchCode', 'Ask the PO and park the story']);
  await expect(buttons.nth(1)).toHaveAttribute('title', 'Sends: BranchCode');
  await page.waitForTimeout(800); // let the lanes finish moving before the picture
  await page.screenshot({ path: 'e2e/.tmp/pm-ask.png' });
  await buttons.nth(1).click();
  await expect(page.getByLabel('Message to Store Returns')).toBeVisible();
});

test('the beacon card for a PM question shows its words and the choices, and a pick sends the reply', async () => {
  // Drop the older question card from the fixture so the PM nudge is the one on the rail.
  const base = JSON.parse(readFileSync(path.resolve('e2e/fixture-snapshot.json'), 'utf8')) as {
    attention: Array<{ kind: string }>;
  };
  base.attention = base.attention.filter((a) => a.kind !== 'question');
  mkdirSync(path.resolve('e2e/.tmp'), { recursive: true });
  const file = path.resolve('e2e/.tmp/fixture-pm-ask.json');
  writeFileSync(file, JSON.stringify(base));
  await app.close();
  await launch(file);

  await expect(page.getByText('Store Returns is waiting on you')).toBeVisible();
  const card = page.locator('.card.blocked');
  await expect(card.getByLabel('What Store Returns said')).toContainText('Which should the delivery form send?');
  const answer = card.getByRole('group', { name: 'Answer' });
  await expect(answer.getByRole('button')).toHaveCount(3);
  await expect(page.getByRole('banner')).toContainText('1 needs you');
  await page.screenshot({ path: 'e2e/.tmp/pm-ask-card.png' });
  await answer.getByRole('button', { name: 'BranchCode' }).click();
  await expect(page.getByRole('heading', { name: 'Store Returns' })).toBeVisible();
});

test("product questions: a PM lane lists its own and its moons' with one-click answers, and Decisions gathers them all for the PO", async () => {
  // Three from the PMs and one from a story moon.
  await expect(page.getByRole('button', { name: 'Decisions · 4' })).toBeVisible();

  await page.getByRole('button', { name: 'Open Storefront' }).click();
  const mine = page.getByRole('list', { name: 'Product questions' });
  const items = mine.getByRole('listitem');
  // Shop's own three plus Q9 from its story moon, open ones first.
  await expect(items).toHaveCount(4);
  await expect(items.nth(0)).toContainText('Q1');
  await expect(items.nth(0)).toContainText('which store should the paperwork show?');
  await expect(items.nth(0)).toContainText('Today');
  await expect(items.nth(0)).toContainText('Proposed');
  await expect(items.nth(0)).toContainText('story 100203');
  const choices = items.nth(0).getByRole('group', { name: 'Choices for Q1' });
  await expect(choices.getByRole('button')).toHaveText(['The delivery store', 'The ordering store']);
  await expect(choices.getByRole('button', { name: 'The delivery store' })).toHaveAttribute(
    'title',
    'The PM recommends this',
  );
  await expect(items.nth(1)).toContainText('sent to PO');
  await expect(items.nth(2)).toContainText('Q9');
  await expect(items.nth(3)).toContainText('Answered: Name only.');
  await expect(items.nth(3)).toContainText('reaches Storefront when it is next between turns');
  await expect(items.nth(3).getByRole('button')).toHaveText(['forget']);
  const answerBox = items.nth(0).getByLabel('Answer Q1');
  const answerButton = items.nth(0).getByRole('button', { name: 'Answer', exact: true });
  await expect(answerButton).toBeDisabled();
  await answerBox.fill('The delivery store, like today.');
  await expect(answerButton).toBeEnabled();
  await page.screenshot({ path: 'e2e/.tmp/decisions-lane.png' });
  await answerButton.click();

  await page.getByRole('button', { name: 'Close lane view' }).click();
  await page.getByRole('button', { name: 'Decisions · 4' }).click();
  const all = page.getByRole('list', { name: 'All lanes' });
  await expect(all.getByRole('listitem')).toHaveCount(5);
  await expect(all.getByRole('listitem').nth(2)).toContainText('Cart');
  await page.waitForTimeout(800); // let the panel finish rising before the picture
  await page.screenshot({ path: 'e2e/.tmp/decisions-panel.png' });
  await page.getByRole('button', { name: 'Copy for PO' }).click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
  const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
  expect(clip).toMatch(/^Product questions from the Truck Care rebuild — /);
  expect(clip).toContain('1. When a shopper picks up an order at a store, which store should the paperwork show?');
  expect(clip).toContain('   Options: The delivery store (recommended) / The ordering store');
  expect(clip).toContain('3. Can a cart with no tag be taken in at the door?');
  expect(clip).not.toContain('guest customer');
});

test('the theme starts dark and cycles dark → light → system, and the whole page follows', async () => {
  const html = page.locator('html');
  const button = page.getByRole('button', { name: /^Theme:/ });
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(button).toHaveAccessibleName(/Theme: dark/);
  await button.click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  // The body fades to the new tint over two seconds, so read the token the tint effect wrote.
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.style.getPropertyValue('--stage-bg')))
    .toMatch(/^#[c-f][0-9a-f]{5}$/i);
  await expect
    .poll(async () => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme))
    .toBe('light');
  const panelText = await page.evaluate(() => getComputedStyle(document.querySelector('.legend')!).color);
  expect(panelText).toBe('rgb(71, 85, 105)');
  await page.waitForTimeout(2200);
  await page.screenshot({ path: 'e2e/.tmp/light.png' });
  await page.getByRole('button', { name: 'Open Storefront' }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'e2e/.tmp/light-lane.png' });
  await page.getByRole('button', { name: 'Close lane view' }).click();
  await button.click();
  await expect(button).toHaveAccessibleName(/follows Windows/);
  await expect(html).toHaveAttribute('data-theme', /^(dark|light)$/);
  await button.click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
});

test('the home row keeps config order however busy a lane is, and nothing overlaps', async () => {
  // Lane centers from the physics transform (the bob and zoom live on inner groups).
  const positions = () =>
    page.evaluate(() => ({
      width: document.querySelector('svg.stage')!.getBoundingClientRect().width,
      lanes: Array.from(document.querySelectorAll('g.lane')).map((g) => ({
        name: g.querySelector('[role=button]')?.getAttribute('aria-label') ?? '',
        x: Number(/translate\(([-\d.]+)px/.exec((g as SVGGElement).style.transform)?.[1]),
      })),
    }));
  await expect(page.getByRole('button', { name: 'Open Store Returns' })).toBeVisible();
  // Each lane starts at its slot and glides to rest; the resting picture is what we assert, and
  // settling can pause when another test's window covers this one, so give it time.
  await expect
    .poll(
      async () => {
        const { width, lanes } = await positions();
        if (lanes.length !== 6 || lanes.some((l) => Number.isNaN(l.x))) return 'not rendered';
        const sorted = [...lanes].sort((a, b) => a.x - b.x);
        const gaps = sorted.slice(1).map((l, i) => l.x - sorted[i].x);
        return {
          // The cores are drawn in config order, so left to right should read the same way.
          inOrder: sorted.map((l) => l.name).join() === lanes.map((l) => l.name).join(),
          spaced: gaps.every((g) => g > 120),
          inside: sorted[0].x > 24 && sorted[sorted.length - 1].x < width - 24,
        };
      },
      { timeout: 20_000, intervals: [250] },
    )
    .toEqual({ inOrder: true, spaced: true, inside: true });
});

test('galaxy: this sprint’s merges sit in the Milky Way, clear of every core, and a new merge launches from the PR monitor', async () => {
  // The rail's cards sit over the left of the sky; clear them so the pointer can reach the stars.
  const base = JSON.parse(readFileSync(path.resolve('e2e/fixture-snapshot.json'), 'utf8')) as {
    attention: unknown[];
    stars: Array<Record<string, unknown>>;
  };
  base.attention = [];
  mkdirSync(path.resolve('e2e/.tmp'), { recursive: true });
  const file = path.resolve('e2e/.tmp/fixture-sky.json');
  writeFileSync(file, JSON.stringify(base));
  await app.close();
  await launch(file);

  const shop = page.locator('[data-pm="shop"]');
  // Five Shop merges in Sprint 41 and two from Sprint 40, faded; a moon still on stage no longer holds one back.
  await expect(shop.getByRole('link')).toHaveCount(5);
  await expect(shop.locator('circle.faded')).toHaveCount(2);
  await expect(page.locator('[data-pm="cart"]').getByRole('link')).toHaveCount(2);
  await expect(page.locator('[data-pm="store"]')).toHaveCount(0, { timeout: 1000 });
  // No lines, bridges, or sprint label: the sky is ambience.
  await expect(page.locator('g.constellations path.line, g.constellations path.bridge')).toHaveCount(0);
  await expect(page.locator('g.constellations text')).toHaveCount(0);
  // Seven merges is a quiet sprint, so every star is full size.
  await expect(shop.locator('circle.dot').first()).toHaveAttribute('r', '4.6');

  // The band is painted behind the stage in the dark theme.
  const bandPainted = () =>
    page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('orbit-galaxy-band canvas');
      const d = c?.getContext('2d')?.getImageData(0, 0, c.width, c.height).data;
      if (!d) return 0;
      let lit = 0;
      for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 0) lit++;
      return lit;
    });
  await expect.poll(bandPainted).toBeGreaterThan(1000);

  // Every star keeps clear of every core, once the row has come to rest.
  await expect
    .poll(async () => {
      const cores = await page.locator('circle.core').evaluateAll((els) =>
        els.map((e) => {
          const r = e.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, r: r.width / 2 };
        }),
      );
      const stars = await page.locator('g.constellations [role="link"]').evaluateAll((els) =>
        els.map((e) => {
          const r = e.querySelector('circle.dot')!.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }),
      );
      if (!cores.length || stars.length !== 7) return 'not rendered';
      return stars.every((s) => cores.every((c) => Math.hypot(s.x - c.x, s.y - c.y) > c.r + 44));
    })
    .toBe(true);

  // The sky leans away from the pointer as one piece: the band, its PR stars, and the far stars
  // by the same amount, the near stars a little more.
  await page.mouse.move(5, 300);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const t = (sel: string) => (document.querySelector(sel) as HTMLElement | SVGElement | null)?.style.transform;
        return {
          band: t('orbit-galaxy-band'),
          stars: t('g.constellations'),
          far: t('orbit-starfield .far'),
          near: t('orbit-starfield .near'),
        };
      }),
    )
    .toMatchObject({ band: expect.stringMatching(/^translate\([1-9]/) });
  const lean = await page.evaluate(() => {
    const t = (sel: string) => (document.querySelector(sel) as HTMLElement | SVGElement).style.transform;
    return {
      band: t('orbit-galaxy-band'),
      stars: t('g.constellations'),
      far: t('orbit-starfield .far'),
      near: t('orbit-starfield .near'),
    };
  });
  expect(lean.stars).toBe(lean.band);
  expect(lean.far).toBe(lean.band);
  expect(lean.near).not.toBe(lean.band);

  const star = shop.getByRole('link', { name: /Story 100233/ });
  await star.hover();
  await expect(page.locator('g.tip')).toContainText('100233 · Coupon pick before save');
  await expect(page.locator('g.tip')).toContainText('PR #7635 · merged');
  await page.screenshot({ path: 'e2e/.tmp/constellations-dark.png' });
  await page.getByRole('button', { name: /Theme: dark/ }).click();
  await star.hover();
  // The light theme has no band, only the stars.
  await expect.poll(bandPainted).toBe(0);
  await page.screenshot({ path: 'e2e/.tmp/constellations-light.png' });

  await page.getByRole('button', { name: 'Open Storefront' }).click();
  await expect(page.locator('g.constellations')).toHaveClass(/away/);
  await page.getByRole('button', { name: 'Close lane view' }).click();
  await expect(page.locator('g.constellations')).not.toHaveClass(/away/);

  // A PR merges while you watch: it bursts at the PR monitor and its star lands in Shop's sky.
  const merged = {
    ...base,
    stars: [
      ...base.stars,
      {
        id: 'shop-pr-7170',
        pmId: 'shop',
        storyId: '100248',
        title: 'Merged just now',
        pr: 7170,
        prUrl: 'https://github.com/contoso/storefront/pull/7170',
        sprint: 'Storefront\\Sprint 41',
        at: Date.now(),
      },
    ],
  };
  await app.evaluate(({ BrowserWindow }, snapshot) => {
    BrowserWindow.getAllWindows()[0].webContents.send('orbit:event', { type: 'snapshot', snapshot });
  }, merged);
  const landed = shop.getByRole('link', { name: /Story 100248/ });
  await expect(landed).toHaveClass(/arriving/);
  await expect(landed.locator('circle.burst')).toHaveCount(1);
  await expect(shop.getByRole('link')).toHaveCount(6);
  await expect(shop.getByRole('link', { name: /Story 100248/ })).toHaveClass(/newest/);
  // The flash sits just over the PR monitor's planet, not Shop's. (The burst ring is mid-scale, so
  // its box is no guide.) Both are read in one frame, since the row may still be gliding home from
  // the focus view.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const flash = document.querySelector('[data-pm="shop"] circle.core-flash')?.getBoundingClientRect();
        const core = document.querySelector('circle.core[aria-label="Open PR Monitor"]')?.getBoundingClientRect();
        if (!flash || !core) return 'not rendered';
        const dx = Math.abs(flash.x + flash.width / 2 - (core.x + core.width / 2));
        return dx < 12 && flash.y + flash.height / 2 < core.y + core.height / 2;
      }),
    )
    .toBe(true);
  // The stars that were already there stay put.
  await expect(shop.getByRole('link', { name: /Story 100233/ })).not.toHaveClass(/arriving/);
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'e2e/.tmp/constellations-supernova.png' });
});

test('story moons circle their PM, open their own panel, and roll up into the PM', async () => {
  // Two stories on moons around Shop: one building, one with its PR open.
  const building = page.getByRole('button', { name: 'Open story 100203' });
  const opened = page.getByRole('button', { name: 'Open story 100204' });
  await expect(building).toBeVisible();
  await expect(opened).toBeVisible();
  await expect(page.getByText('stories $3.50')).toBeVisible();
  // Moons are not on the home row.
  await expect(page.locator('g.lane')).toHaveCount(6);
  // Decisions counts the moon's question; the PM core would say so when idle.
  await expect(page.getByRole('button', { name: 'Decisions · 4' })).toBeVisible();

  // Moons revolve, so the test fires the click on the moon itself; a person hovers and it holds still.
  await building.dispatchEvent('click');
  const panel = page.getByRole('heading', { name: '100203 · Delivery question in the review step' });
  await expect(panel).toBeVisible();
  await expect(page.getByLabel('Story', { exact: true })).toContainText('building');
  await expect(page.getByLabel('Story', { exact: true })).toContainText('users/pdoe/100203-delivery-question');
  await expect(page.getByLabel('Story', { exact: true })).toContainText('2 files claimed');
  await expect(page.getByRole('listitem', { name: /^Q9 If the shopper skips the delivery question/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Board' })).toHaveCount(0);
  // A story still building cannot be dismissed.
  const lanePanel = page.locator('orbit-lane-panel');
  await expect(lanePanel.getByRole('button', { name: 'Dismiss', exact: true })).toHaveCount(0);
  await page.waitForTimeout(900);
  await page.screenshot({ path: 'e2e/.tmp/moon-panel.png' });

  // Back to the PM: its panel lists the stories and their costs.
  await page.getByRole('button', { name: '← Storefront' }).click();
  await expect(page.getByRole('heading', { name: 'Storefront' })).toBeVisible();
  const stories = page.getByRole('list', { name: 'Stories' });
  await expect(stories).toContainText('Stories · 2');
  await expect(stories).toContainText('100203 Delivery question in the review step');
  await expect(stories).toContainText('100204 Shopper N/A keeps the gift note hidden');
  await expect(stories).toContainText('PR #7123');
  // Only the finished story offers a dismiss.
  await expect(stories.getByRole('button', { name: 'Dismiss story 100204' })).toBeVisible();
  await expect(stories.getByRole('button', { name: 'Dismiss story 100203' })).toHaveCount(0);
  await stories.getByRole('button', { name: 'Open' }).nth(1).click();
  await expect(page.getByRole('heading', { name: '100204 · Shopper N/A keeps the gift note hidden' })).toBeVisible();
  await expect(page.getByLabel('Story', { exact: true }).getByRole('button', { name: 'PR #7123' })).toBeVisible();
  await expect(lanePanel.getByRole('button', { name: 'Dismiss', exact: true })).toBeVisible();
});

/** Stand in for the command handler: record every command, and say whether a send was delivered. */
async function recordCommands(): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { __cmds: Array<Record<string, unknown>>; __deliver: boolean };
    g.__cmds = [];
    g.__deliver = true;
    ipcMain.removeHandler('orbit:command');
    ipcMain.handle('orbit:command', (_e, cmd: Record<string, unknown>) => {
      g.__cmds.push(cmd);
      return cmd.type === 'send' ? { delivered: g.__deliver } : undefined;
    });
  });
}
const commands = () => app.evaluate(() => (globalThis as unknown as { __cmds: Array<Record<string, unknown>> }).__cmds);
const deliver = (on: boolean) =>
  app.evaluate((_e, v) => {
    (globalThis as unknown as { __deliver: boolean }).__deliver = v;
  }, on);

test('drafts stay with their lane, Enter sends everywhere, and a message no lane took stays in the box', async () => {
  await recordCommands();
  await page.getByRole('button', { name: 'Open Storefront' }).click();
  const shop = page.getByLabel('Message to Storefront');
  await expect(shop).toHaveAttribute('placeholder', /Enter sends, Shift\+Enter for a new line/);
  await shop.fill('hold the wizard');
  await page.getByRole('button', { name: 'Close lane view' }).click();
  await page.getByRole('button', { name: 'Open Store Returns' }).click();
  const store = page.getByLabel('Message to Store Returns');
  await expect(store).toHaveValue('');
  await store.fill('delivery form first');
  await page.getByRole('button', { name: 'Close lane view' }).click();
  await page.getByRole('button', { name: 'Open Storefront' }).click();
  await expect(shop).toHaveValue('hold the wizard');

  // Shift+Enter is a new line, not a send.
  await shop.press('Shift+Enter');
  await expect(shop).toHaveValue('hold the wizard\n');
  expect((await commands()).filter((c) => c.type === 'send')).toHaveLength(0);

  // Nobody took it: the words stay and the panel says why.
  await deliver(false);
  await shop.press('Enter');
  await expect(page.locator('orbit-lane-panel').getByRole('alert')).toHaveText("Not sent: Storefront isn't running.");
  await expect(shop).toHaveValue('hold the wizard');

  // Delivered with an interrupt: the box clears and the interrupt box resets.
  await deliver(true);
  const now = page.getByLabel('deliver now (interrupts)');
  await now.check();
  await shop.press('Enter');
  await expect(shop).toHaveValue('');
  await expect(now).not.toBeChecked();
  await expect(page.locator('orbit-lane-panel').getByRole('alert')).toHaveCount(0);
  const sends = (await commands()).filter((c) => c.type === 'send');
  expect(sends.map((c) => [c.laneId, c.text, c.priority])).toEqual([
    ['shop', 'hold the wizard', 'next'],
    ['shop', 'hold the wizard', 'now'],
  ]);
});

/** A real one-pixel PNG, small enough to go as it is. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** Fire a paste or a drop of `count` PNG files on the element, the way the clipboard or Explorer would. */
async function giveImages(target: Locator, kind: 'paste' | 'drop', count = 1): Promise<void> {
  await target.evaluate(
    (el, { b64, kind, count }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      for (let i = 0; i < count; i++) data.items.add(new File([bytes], `shot-${i}.png`, { type: 'image/png' }));
      const init = { bubbles: true, cancelable: true };
      el.dispatchEvent(
        kind === 'paste'
          ? new ClipboardEvent('paste', { ...init, clipboardData: data })
          : new DragEvent('drop', { ...init, dataTransfer: data }),
      );
    },
    { b64: PNG, kind, count },
  );
}

test('a screenshot pasted, dropped, or picked goes with the message, and comes back if nobody took it', async () => {
  await recordCommands();
  await page.getByRole('button', { name: 'Open Storefront' }).click();
  const shop = page.getByLabel('Message to Storefront');
  const thumbs = page.getByLabel('Screenshots to send').getByRole('img');
  const alert = page.locator('orbit-lane-panel').getByRole('alert');

  // Win+Shift+S then Ctrl+V, a drop from Explorer, and the Attach picker all land as thumbnails.
  await giveImages(shop, 'paste');
  await expect(thumbs).toHaveCount(1);
  await giveImages(shop, 'drop');
  await expect(thumbs).toHaveCount(2);
  await page.getByRole('button', { name: 'Remove screenshot 2' }).click();
  await expect(thumbs).toHaveCount(1);
  await page
    .locator('input[type="file"][aria-label="Choose screenshots"]')
    .setInputFiles({ name: 'picked.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') });
  await expect(thumbs).toHaveCount(2);
  await page.screenshot({ path: 'e2e/.tmp/composer-screenshots.png' });

  // Nobody took it: the words and the screenshots both stay.
  await deliver(false);
  await shop.fill('this toast never clears');
  await shop.press('Enter');
  await expect(alert).toHaveText("Not sent: Storefront isn't running.");
  await expect(shop).toHaveValue('this toast never clears');
  await expect(thumbs).toHaveCount(2);

  // Taken: they go together and the composer clears.
  await deliver(true);
  await shop.press('Enter');
  await expect(shop).toHaveValue('');
  await expect(thumbs).toHaveCount(0);
  const sends = (await commands()).filter((c) => c.type === 'send');
  expect(sends.at(-1)).toEqual({
    type: 'send',
    laneId: 'shop',
    text: 'this toast never clears',
    priority: 'next',
    images: [
      { mediaType: 'image/png', data: PNG },
      { mediaType: 'image/png', data: PNG },
    ],
  });

  // A screenshot needs no words, and only five go with one message.
  await giveImages(shop, 'paste', 6);
  await expect(thumbs).toHaveCount(5);
  await expect(alert).toHaveText('Only 5 screenshots go with one message.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(thumbs).toHaveCount(0);
  const last = (await commands()).filter((c) => c.type === 'send').at(-1) as { text: string; images: unknown[] };
  expect([last.text, last.images.length]).toEqual(['', 5]);

  // A 4K screenshot is redrawn with its long edge at 2000px before it goes.
  await shop.evaluate(async (el) => {
    const canvas = new OffscreenCanvas(3840, 2160);
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#2b5f8a';
    g.fillRect(0, 0, 3840, 2160);
    const data = new DataTransfer();
    data.items.add(new File([await canvas.convertToBlob({ type: 'image/png' })], '4k.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  });
  await expect(thumbs).toHaveCount(1);
  await shop.press('Enter');
  await expect(thumbs).toHaveCount(0);
  const big = (await commands()).filter((c) => c.type === 'send').at(-1) as {
    images: Array<{ mediaType: string; data: string }>;
  };
  const size = await page.evaluate(async ({ mediaType, data }) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mediaType }));
    return [bitmap.width, bitmap.height];
  }, big.images[0]);
  expect(size).toEqual([2000, 1125]);
});

test('the question card shows previews and its lane panel has it too, answers in the SDK shape, and the rail steps between items', async () => {
  await recordCommands();
  const rail = page.locator('orbit-attention-rail');
  const card = rail.locator('orbit-question-card');
  await expect(card.locator('.chip', { hasText: 'Store code' })).toBeVisible();
  await card.getByText('StoreCode', { exact: false }).hover();
  await expect(card.getByLabel('Preview for Store code')).toContainText('<StoreCode>00123</StoreCode>');

  // Step to the other item and back.
  await rail.getByRole('button', { name: 'Store Returns · blocked' }).click();
  await expect(rail.getByText('Store Returns is waiting on you')).toBeVisible();
  await rail.getByRole('button', { name: 'Cart · question' }).click();
  await expect(card).toBeVisible();

  // The lane's own panel carries the card; Other and a pick replace each other.
  await page.getByRole('button', { name: 'Open Cart' }).click();
  const inPanel = page.locator('orbit-lane-panel orbit-question-card');
  await expect(inPanel).toContainText('Which Store code should the form send?');
  const store = inPanel.getByLabel('StoreCode', { exact: false });
  await store.check();
  await inPanel.getByLabel('Other answer for Store code').fill('Both, by region');
  await expect(store).not.toBeChecked();
  await store.check();
  await expect(inPanel.getByLabel('Other answer for Store code')).toHaveValue('');
  await inPanel.getByLabel('Notes for Store code').fill('only on Store forms');
  await inPanel.getByRole('button', { name: 'Answer' }).click();
  const answer = (await commands()).find((c) => c.type === 'answer');
  expect(answer).toEqual({
    type: 'answer',
    attentionId: 'a1',
    answers: { 'Which Store code should the form send?': 'StoreCode' },
    annotations: {
      'Which Store code should the form send?': {
        preview: '<StoreForm>\n  <StoreCode>00123</StoreCode>\n</StoreForm>',
        notes: 'only on Store forms',
      },
    },
  });
});

test('a moon parked on another story’s files says so, names the holder, and can be dismissed', async () => {
  const base = JSON.parse(readFileSync(path.resolve('e2e/fixture-snapshot.json'), 'utf8')) as {
    lanes: Array<{ id: string; status: string; story?: Record<string, unknown> }>;
  };
  const lanes = base.lanes.map((l) =>
    l.id === 'story-shop-100203'
      ? { ...l, status: 'idle', story: { ...l.story, stage: 'waiting', waitingOn: ['100165'] } }
      : l,
  );
  await app.evaluate(
    ({ BrowserWindow }, snapshot) => {
      BrowserWindow.getAllWindows()[0].webContents.send('orbit:event', { type: 'snapshot', snapshot });
    },
    { ...base, lanes },
  );

  const moon = page.getByRole('button', { name: 'Open story 100203' });
  await expect(moon).toContainText('waiting');
  await moon.dispatchEvent('click');
  const story = page.getByLabel('Story', { exact: true });
  await expect(story).toContainText('waiting on 100165 to let go of its files');
  await expect(page.locator('orbit-lane-panel').getByRole('button', { name: 'Dismiss', exact: true })).toBeVisible();

  await page.getByRole('button', { name: '← Storefront' }).click();
  const stories = page.getByRole('list', { name: 'Stories' });
  await expect(stories).toContainText('waiting');
  await expect(stories.getByRole('button', { name: 'Dismiss story 100203' })).toBeVisible();
});

test('the corner panel shows free memory, who holds the test slots, and who is in line', async () => {
  const GB = 1024 ** 3;
  const base = JSON.parse(readFileSync(path.resolve('e2e/fixture-snapshot.json'), 'utf8')) as Record<string, unknown>;
  const now = Date.now();
  base.guard = {
    headroomBytes: 16.6 * GB,
    totalBytes: 32 * GB,
    state: 'normal',
    slots: [
      {
        laneId: 'story-shop-100204',
        agentId: null,
        label: 'nx affected',
        startedAt: now - 3 * 60_000,
        background: false,
      },
      { laneId: 'cart', agentId: 'a1', label: 'nx test', startedAt: now - 40_000, background: false },
    ],
    waiting: [
      { laneId: 'story-shop-100203', agentId: null, label: 'jest', since: now, reason: 'slot', kind: 'command' },
    ],
  };
  mkdirSync(path.resolve('e2e/.tmp'), { recursive: true });
  const file = path.resolve('e2e/.tmp/fixture-guard.json');
  writeFileSync(file, JSON.stringify(base));
  await app.close();
  await launch(file);

  const panel = page.getByRole('status', { name: 'Memory and test slots' });
  await expect(panel).toContainText('16.6 GB free');
  await expect(panel).toContainText('100204');
  await expect(panel).toContainText('nx affected · 3m');
  await expect(panel).toContainText('Cart');
  await expect(panel).toContainText('100203');
  await expect(panel).toContainText('in line');
  // It sits above the legend, both in the bottom-right corner.
  const p = (await panel.boundingBox())!;
  const l = (await page.getByLabel('Legend').boundingBox())!;
  expect(p.y + p.height).toBeLessThanOrEqual(l.y);
  expect(Math.abs(p.x + p.width - (l.x + l.width))).toBeLessThan(2);
  // The moons say where they stand in the line under their numbers.
  await expect(page.getByText('testing', { exact: true })).toBeVisible();
  await expect(page.getByText('in line', { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: 'e2e/.tmp/guard-panel.png' });
});

test('without a memory reading the corner shows only the legend', async () => {
  await expect(page.getByLabel('Legend')).toBeVisible();
  await expect(page.getByRole('status', { name: 'Memory and test slots' })).toHaveCount(0);
});

test('the memory alert names the problem, not a lane, and offers only Dismiss', async () => {
  const base = JSON.parse(readFileSync(path.resolve('e2e/fixture-snapshot.json'), 'utf8')) as Record<string, unknown>;
  base.attention = [
    {
      id: 'mem-1',
      laneId: 'shop',
      kind: 'error',
      raisedAt: Date.now(),
      code: 'memory',
      message: 'Memory is almost out (2.4 GB free). Biggest right now: jest 5.8 GB. Nothing was stopped.',
    },
  ];
  mkdirSync(path.resolve('e2e/.tmp'), { recursive: true });
  const file = path.resolve('e2e/.tmp/fixture-memory-alert.json');
  writeFileSync(file, JSON.stringify(base));
  await app.close();
  await launch(file);

  const card = page.locator('.card.error');
  await expect(card).toContainText('Memory almost out');
  await expect(card).not.toContainText('Storefront');
  await expect(card).toContainText('Nothing was stopped.');
  await expect(card.getByRole('button', { name: 'Dismiss' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Resume' })).toHaveCount(0);
});
