# Storefront runbook

Repo facts the PM, the debugger, the PR monitor, and the fixers read. Keep it short and true.

## Required checks

A PR can't merge until these pass: `build`, `unit`, `lint`, and `e2e-web`.

## Known flakes

- The `e2e-web` checkout spec times out on a cold runner now and then. Re-run it once before digging.
- The `api` coverage upload step fails when the coverage service is down. It isn't a required check.

## Reviewer team

Frontend changes go to the web team, API changes to the platform team. A PR that touches both needs one
approval from each.

## False trails

- A red `format` check is almost always a file the formatter would rewrite. Run `npx nx format:write` before
  reading the failure.
- `nx affected` runs everything when a root file such as `package-lock.json` or `nx.json` changed. That is
  expected, not a broken base ref.

## Red checks that aren't code bugs

The PM reads this list when the user brings it a failure. A match is not a code bug, so nobody gets sent to fix
the test.

- **`e2e-web` red with zero tests run**: the `E2E_API_SECRET` the suite boots the API with has expired. The web
  suite starts the API too, so this reddens every PR at once. Rotating the secret fixes it, not a code change.
- **The two cart specs fail together on a click**: the payment provider's sandbox isn't mocked. When it returns a
  500, its error dialog's overlay sits over the page and every click after it times out. Environmental. Don't
  send an agent to fix the test.
- **A PR's E2E broke with no file overlap with anything that merged**: a merged PR added a step other specs walk
  through, like a confirm dialog or a required field. File-overlap checks miss it.
- **Every open PR went red at once with no code change**: a spec that doesn't stub its feature flags read the
  live flag service, and someone flipped a flag.
- **`publish-reports` red**: two PRs raced to push the test-report site. It isn't a required check. Don't debug
  it.

`build`, `unit`, and `lint` run on the merge commit; `e2e-web` runs on the branch head. A stale PR's green E2E
proves nothing about how the base branch looks after the merge.

## Gate quirks

The story engine and the AC gate read these before trusting a local gate run.

- **The formatter is pinned.** `package.json` pins prettier, and `nx format:check` runs that pinned copy. Run it
  through `npx` from the worktree, never a global install: a newer major formats differently (trailing commas, for
  one) and CI stays red.
- **A local format check on Windows flags every file.** Git checks files out with CRLF line endings and the prettier
  config says `endOfLine: lf`. Trust the CI log over the local run, and don't mass `--write` on the strength of it.
  To check locally, run prettier on just the changed files with `--end-of-line auto`.
- **Neither test nor lint compiles component SCSS.** A broken relative `@use` passes both and fails at app build.
  If a lane moved or added a partial, compile it with `npx sass <file>`.
- **Unit green is not boot green on `api`.** A service that injects the request-context provider needs that
  provider's module in its own module's `imports`. The unit tests mock it and pass; the app fails at boot.

## Worktrees

- **No `.env` in a worktree:** `api` serve dies at boot on a missing required variable. The bootstrap copies it
  from the main checkout. If a serve dies like that, check the bootstrap's summary before the code.
- **The E2E login credentials live in `apps/web-e2e/.env.local`**, not in `.env`. Without it the suite's global
  setup times out on the sign-in page before a single spec runs. The bootstrap copies every `.env.local`.
- **`node_modules` is linked, never installed.** An install inside the linked folder writes into the main
  checkout's copy.

## Packages and contracts

The architect reads this to resolve paths and design the contract. Never derive an alias from a folder name.

- **Aliases come from `tsconfig.base.json`.** `grep -n "<dir>" tsconfig.base.json` gives the import alias, and
  `npx nx show projects --json` gives the project name. Both can differ from the folder, and a few aliases point at
  directories that no longer exist, so confirm the target.
- **Shared contracts live in `libs/<domain>/shared/type-*`.** The server's DTO class `implements` the interface and
  carries the API docs decorators. The client imports the interface. Use domain names and real `boolean`, `number`,
  and `Date` types. Order numbers stay `string`.
- **Boundaries.** A domain lib never imports another domain's lib, and `libs/shared/*` never imports a domain lib.
  A buildable lib that gains a new cross-lib import needs the matching `peerDependencies` entry.
- **Request bodies.** A `@Body()` typed as an interface skips validation. Type it as the DTO class.
- **Silent failures.** A feature flag key that doesn't exist in the flag service reads as off with no error.

## UI

The UX designer reads this. The example web app uses a component library for controls and Bootstrap for layout.
The library below is a placeholder to show the shape. Name your own, with its own traps.

- **Who uses it:** the shoppers who browse and check out. Copy uses their words ("cart", "order"), never internal
  terms.
- **Controls from the component library, layout from Bootstrap utilities.** No new colors or type sizes outside
  the theme, and no pixel widths.
- **Finding elements from a test:** no `data-testid`. A control gets a real label, and `getByRole` / `getByLabel`
  find it.
- **Library traps (example):**
  - The numeric input's change event fires on every keystroke, so don't call the API from it.
  - Escape on a closed combo box writes `undefined` into a non-nullable form control.
  - Dialog inputs are set through the dialog's own input API, not by assigning a property.
  - A wrapped library control breaks the label-association lint rule unless it is registered with it.
- **Legacy parity:** none. The storefront has no older app to match, so the legacy consult is off.

## Frontend rules

The frontend lane and the debugger read this. Sample rules from the Angular web app.

- **Error shape.** The global error interceptor rethrows a plain `{ message, status }` object, so `instanceof
  HttpErrorResponse` is always false in the running app. Read the status off the shape. A unit test with a bare
  `provideHttpClient()` proves nothing: wire `withInterceptors([errorHandlerInterceptor])`.
- **Mock-store leaks.** `provideMockStore` selector overrides mutate the real selector singletons and survive
  `resetTestingModule`, so a later real-store test can pass for the wrong reason.
- **NG8118** fires when a required input is invoked too early, not on template narrowing. Fix it with a deferred arrow
  (`linkedSignal`). Never loosen the input.
- **Sizing.** Relative units only (%, rem, vh/vw). Check `node_modules/bootstrap/scss/_utilities.scss` before writing
  new SCSS.
- **Compile moved SCSS.** Neither lint nor test compiles it. Run `npx sass <file>` on any partial a lane moved or
  added (see Gate quirks).
- **Lint scopes.** The `web` project's lint config forbids importing from `apps/api`. Run the project's own lint
  target, not a root-level one, so the scope rules apply.

## API rules

The backend lane and the debugger read this. Sample rules from the NestJS API.

- **The API is an experience layer, not a passthrough.** Reshape payloads from the payment and inventory services
  into DTOs designed for the web app: domain names, real `boolean`, `number`, and `Date`, aggregated so the client
  doesn't stitch fragments. When touching a legacy passthrough DTO, improve it rather than extending it.
- **Error contract.** An upstream service failure goes through `Errors.upstream(...)` and returns a 502. A failure
  inside the API goes through `Errors.internal(...)` and returns a 500. Both carry `safeMessage: true` and survive
  the global exception filter. A plain `InternalServerErrorException` is scrubbed to "Internal Server Error".
- **Request context at boot.** A service that injects the request-context service needs the request-context module in
  its module's `imports`, or Nest throws `UnknownDependenciesException` at boot (see Gate quirks).
- **New cross-lib import in a buildable lib.** Add it to that lib's `package.json` `peerDependencies`, or the
  `dependency-checks` lint fails. Never run `npm install` to fix it: that churns `package-lock.json`.
- **No sockets or gateways, ever.** The API must not add a websocket server or gateway. Realtime goes from the
  client to the chat vendor directly.

## Upstream data quirks

The debugger reads this. Each one produces a weird bug that points nowhere near its cause.

- A quantity can carry a trailing sign: `parseFloat('5.000-')` returns +5 with no error.
- `'00000000'` is the upstream's unset date. A length-8 check accepts it and yields a date in 1899.
- Flags arrive as `'X'`, `'x'`, `' X '`, or `''`. A bare `=== 'X'` silently misreads them.
- A fault can arrive inside an HTTP 200. Read the body before trusting a 2xx.

## CI failure lessons

The PR shepherd and ci-watch read this before fixing a red check. Sample lessons from the example storefront.

- **A sign-in redirect timeout in `e2e-web` is flake until it repeats.** Rerun the failed jobs once. The same failure
  twice is real.
- **A rerun is refused while any job in the run is still going.** Wait for the whole run to finish first.
- **A new import between two packages can fail `lint` on dependency checks.** Add the matching entry to the buildable
  package's `peerDependencies`. Don't run an install to fix it.
- **A selector failure in a spec usually means the component library changed its markup.** Re-find the control by its
  role or label, and don't loosen the assertion.
- **A semantic conflict in a cart or order mapper goes to the user.** Two people changing the same price calculation
  is never a mechanical merge.

## Review

The review agents read this. Sample rules.

- **Request identity.** The web app sends a user-info header. The API decodes it into request context. That value is
  client-asserted: fine for logging and display, never for an access decision. The verified token is the source of
  truth.
- **Test rules.** End-to-end specs use the repo's fixture module, never a manual `browser.newContext()` next to a
  fixture `page`. No `waitForTimeout()`. Mock data lives in `mock-data/` as exported constants.
- **Flag quirk.** Upstream flags arrive as `'X'`, `'x'`, `' X '`, or `''`. A bare `=== 'X'` is a finding unless a
  shared helper already normalized the value.

## PR monitor

The PR monitor reads this before it merges. The template with every section is the plugin's
`docs/runbook-template.md`.

- **Merge method:** merge commits (`gh pr merge <n> --merge`). Auto-merge is off.
- **Nobody requested:** request the `web-reviewers` team for a web change and `platform-reviewers` for an API change.
- **The ruleset** wants one approval newer than the last push and every review thread resolved. The branch doesn't
  have to be up to date with `main`, so check content overlap before merging a stale one.

## QA

The QA tester and the test-data scout read this. Everything here is a placeholder to show the shape. Fill in your
own, and keep real credentials out of the file.

- **Target environment:** `https://shop.test.example.com`. This is the only environment a QA pass touches. It is also
  the only one the scout may write to. Never production.
- **Other environments:** `https://shop.stage.example.com`, only when the user names it.
- **Login:** the harness reads `E2E_USERNAME` and `E2E_PASSWORD` from `apps/web-e2e/.env.local`, which is gitignored
  and so exists in the main checkout only. If the file is missing, stop. Never paste the values anywhere.
- **Harness:** `tools/qa-harness/` (a README, a login script, shared helpers). Copy its `.mjs` files to the staging
  folder `tmp/qa/<story>/` so node can resolve the repo's `node_modules`, then run them with `node`.
- **Reports:** `~/.claude/reports/qa/<story>-<date>.md`. Screenshots and logs go in `~/.claude/reports/qa/<story>/`.
- **Paths node reads:** write every harness path and environment value as a native absolute path (a drive letter and
  forward slashes on Windows), never `$HOME` and never a `/c/...` path from a Unix-like shell. Node resolves `/c/...`
  to the wrong folder and writes the login's session-cookie file there, where nobody will look. Re-export the values on
  every shell call.
- **Route to start from:** `/checkout`. Note the store number the session lands on in every report.
- **Deploy proof:** the `Deploy` workflow on `main` (the profile's `qa.deployWorkflow`). It only redeploys the apps a
  push touched, so check the run when timing looks off.
- **Test data:** registry `~/.claude/reports/test-data/registry.md`. Seed customers with saved payment methods are
  listed in `docs/test-seed.md`. Leave them as they are. The scout builds alongside them.
- **Safe to write:** the test environment's API and the `Payments (test)` Postman environment. Nothing else.
- **Endpoint catalog:** `GET customers/search`, `GET customers/:id/preferences`, `GET orders/:store`,
  `POST orders`. Confirm each route in its controller before relying on it.
- **Traps:** order history lookups match `Closed` orders only. A store number and a warehouse number are different
  code spaces. The payment provider's sandbox sometimes answers 500 inside a 200.
