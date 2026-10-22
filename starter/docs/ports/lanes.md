# Port checklist: the build lanes

What each rule of the three sources became in the starter. One line per rule, so a reviewer can tick them against
the sources.

- `an:N` is line N of the source angular agent, `ng:N` of the source nestjs agent, `db:N` of the source debugger
  agent. All three live in the source user's own config, outside this repo.
- Destinations: `frontend.md`, `backend.md`, `debugger.md`, `builder.md`, and `test-healer.md` are `agents/`.
  `runbook` is `examples/nx-web-api/.claude/orbit/runbook.md`. "Profile" is the repo profile (`docs/repo-profile.md`).
- Rulings: keep each source's tools and `model: inherit`; framework rules stay, marked as examples; repo rules move
  to the example runbook; people become "the user"; no rule is merged with another.

## Source angular (to `frontend.md`)

### Front matter

- an:2 · Name `angular` → `name: frontend`.
- an:3 · Description: implements Angular features: components, services, signals, forms, routing, for libs
  and apps client code → `frontend.md` description, same content, framework-neutral, with Angular rules named as
  conditional.
- an:4 · Tools Read, Edit, Write, Bash, Grep, Glob, WebFetch, WebSearch, Agent → kept in full. The `Agent` grant
  served `ux-designer` and `debugger` as well as the dropped css-optimizer, so it stays.
- an:5 · `model: inherit` → kept.

### Opening

- an:10-12 · Implement Angular 20 features with standalone components, signals, a component library and Bootstrap;
  work one step at a time and verify each with a real test run → frontend opening and § Read first; the Angular and
  library facts are in § Angular rules (example) and the runbook's UI section.
- an:14-16 · Follow the Angular instruction file and read it yourself; the repo's CLAUDE.md files carry the general
  rules → § Read first.

### Traps

- an:21-23 · `instanceof HttpErrorResponse` is always false in the running app; the interceptor rethrows a plain
  `{message, status}`; read the status off the shape → § Rules for any frontend repo (error shape), and runbook §
  Frontend rules.
- an:23-24 · A unit test with bare `provideHttpClient()` proves nothing; wire the interceptor → same bullet, and
  runbook § Frontend rules.
- an:24-26 · A numeric input's `valueChange` fires per keystroke; a `switchMap` save cancels the first PUT and the
  upstream returns 500; commit on blur or debounce → kept, with the consequence (cancelling a write mid-request can
  leave the server half-done and return a 500) stated generically, § Rules for any frontend repo (change event per keystroke), and
  the runbook's UI section already holds the numeric-input trap.
- an:27-29 · Neither lint nor unit tests compile component SCSS; a broken `@use` fails at app build; prove it with
  `npx sass` → § Rules for any frontend repo (styles), and runbook § Frontend rules and § Gate quirks.
- an:30-31 · NG8118 means a required input was invoked too early; fix with a deferred arrow (`linkedSignal`), never
  by loosening the input → § Angular rules, first bullet, and runbook § Frontend rules.
- an:32-34 · `provideMockStore` overrides leak across TestBeds, so a later real-store describe can pass for the wrong
  reason → § Angular rules, second bullet; the general version is in § Rules for any frontend repo; runbook §
  Frontend rules.
- an:35-36 · Relative units only, never hardcoded pixel widths; check Bootstrap's utilities before writing new SCSS →
  § Rules for any frontend repo, first bullet; the file path is in runbook § Frontend rules.

### effect() is a last resort

- an:40-42 · An effect that watches one signal and writes another is wrong; Angular's docs say not to use effects
  that way → § Angular rules, the `effect()` bullet.
- an:44 · Step 1: derived, read-only → `computed()` → kept.
- an:45-49 · Step 2: derived but writable, or must reset or prune → `linkedSignal`, keep `previous?.value`, custom
  `equal` for an array source → kept. The two in-repo example paths are dropped: they were company files, so the port
  tells the lane to find examples in the repo's own client code.
- an:50-52 · Step 3: a user action caused it, write in the handler, but only if it is the only writer; with several
  writers use `linkedSignal` → kept.
- an:53 · Step 4: async data keyed off a signal → `toObservable` + `switchMap` into `toSignal()` → kept.
- an:54 · Step 5: DOM work after render → `afterRenderEffect()` → kept. The in-repo example path is dropped, as above.
- an:56-58 · `effect()` is right only when the target is outside the signal graph: localStorage, logging, an
  imperative component-library API, a canvas, a Reactive Form control with `{ emitEvent: false }` → kept.
- an:58-59 · The instruction file's populate effect is fine only because it writes to a form → kept in a generic
  sentence ("the repo's Angular instruction file may show an effect that writes to a form"); the effect's name is
  dropped as a repo fact.
- an:63 · Red flag: the effect body calls `.set()` or `.update()` → kept.
- an:64 · Red flag: needed `untracked()` or `allowSignalWrites` (a no-op since v19) → kept.
- an:65 · Red flag: a spec needs `TestBed.tick()` or `flushEffects()` → kept.
- an:66-67 · Red flag: a computed read right after the write returns stale data → kept.
- an:69-70 · About 38 files already use `effect()` and many predate `linkedSignal`; an existing effect is not
  precedent → kept as "Many existing effects in a repo predate `linkedSignal`. Don't treat an existing effect as
  precedent." The count is dropped as a company fact.

### Delegation

- an:74-75 · A template or SCSS change beyond a one-line fix gets a UI spec from the ux-designer first; ask for one if
  the packet has none → § Delegation, first bullet, `orbit-starter:ux-designer`.
- an:76 · After UI changes, send SCSS cleanup to css-optimizer → dropped: the plan drops css-optimizer. The rule's
  intent stays as a lane duty in § Delegation, third bullet (clean up the stylesheet yourself, prefer the CSS
  framework's utilities).
- an:77 · A bug you can't root-cause in a couple of attempts goes to the debugger → § Delegation, second bullet,
  `orbit-starter:debugger`.

### Evidence

- an:81-82 · Report file and line for every change and paste the test and lint output; "tests pass" without the run is
  a claim → § Gates and evidence.
- an:82-83 · Search current Angular docs when uncertain instead of guessing from memory → § Gates and evidence.

## Source nestjs (to `backend.md`)

### Front matter

- ng:2 · Name `nestjs` → `name: backend`.
- ng:3 · Description: implements BFF endpoints, services, DTOs, controllers, guards, interceptors, and upstream
  integrations for server code; no sockets or gateways → `backend.md` description, same content, framework-neutral.
- ng:4 · Tools Read, Edit, Write, Bash, Grep, Glob, WebFetch, WebSearch (no Agent) → kept, no Agent.
- ng:5 · `model: inherit` → kept.

### Opening and traps

- ng:10-14 · The server is an experience layer, not a passthrough: reshape upstream payloads into consumer DTOs with
  domain names and real boolean, number, and Date, aggregated; improve a legacy passthrough DTO rather than extend it
  → § Rules for any backend repo, first bullet (conditional on the runbook saying so), and runbook § API rules.
- ng:16-18 · Follow the NestJS instruction file and read it yourself; CLAUDE.md files carry the general rules →
  § Read first.
- ng:22-25 · Error contract: an upstream failure is a 502 helper, an internal failure a 500 helper, both
  `safeMessage: true` and surviving the exception filter → § NestJS rules, first bullet, and § Rules for any backend
  repo (second bullet); runbook § API rules. The helper names are generalized (`Errors.upstream`).
- ng:25-26 · A plain `InternalServerErrorException` is scrubbed to "Internal Server Error" → same bullets.
- ng:26-28 · A service injecting `ClsService` needs `ClsModule` in its module's imports or Nest throws
  `UnknownDependenciesException` at boot → § NestJS rules, second bullet; the general version is in § Rules for any
  backend repo, third bullet; runbook § API rules and § Gate quirks.
- ng:28-29 · Unit specs mock it away; verify the module import by eye, because unit green is not boot green → same
  bullets.
- ng:29-31 · A new cross-lib import in a buildable lib goes in that lib's `package.json` peerDeps or
  `nx dependency-checks` lint fails; never `npm install` to fix it → § NestJS rules, third bullet; the general version
  is in § Rules for any backend repo, fourth bullet; runbook § API rules.
- ng:3 (tail) · No Socket.io or gateways; realtime is client-to-vendor only → § NestJS rules, last bullet now "follow the runbook's realtime rule"; the ban itself is in runbook § API rules.

### Evidence

- ng:35-36 · Report file and line for every change and paste the test and lint output; "tests pass" without the run is
  a claim → § Gates and evidence.
- ng:36-37 · Check the framework docs when uncertain instead of guessing from memory → § Gates and evidence.

## Source debugger (to `debugger.md`)

### Front matter

- db:2 · Name `debugger` → kept.
- db:3 · Description: root-causes and fixes failing tests, build and lint breaks, and runtime errors; use proactively
  on any error or test failure → kept, repo-neutral, adds that it reads the runbook's false trails first.
- db:4 · Tools Read, Edit, Write, Bash, Grep, Glob, WebFetch, WebSearch, Skill → kept.
- db:5-6 · `skills:` preload of `superpowers:systematic-debugging` → kept.
- db:7 · `model: inherit` → kept.

### Method

- db:12-13 · Reproduce first, then explain the failure, then fix it; never patch a symptom you can't explain →
  opening paragraph.
- db:17-19 · Follow the systematic-debugging skill's phases; if its content isn't in context, invoke it with the Skill
  tool before anything else → § Method.
- db:23-24 · Reproduce with the exact failing command; project names come from `nx show projects`, not folder names →
  § Method, rule 1 (the Nx command is kept as the example).
- db:25-27 · Verify with the same command that failed, plus the gates against the base when the fix
  touched shared code → § Method, rule 2, using the profile's `gates.test`, with `gates.lint` and `gates.format` marked "when the profile has them", and the base read from `baseBranch` (the Nx affected command is the example).
- db:27-28 · Two honest attempts; if the second fails, report the evidence instead of guessing a third time →
  § Method, rule 3.

### Known false trails (to the runbook)

- db:34-36 · Local `prettier --check` flags every file on Windows (CRLF vs `endOfLine: lf`); trust the CI log, re-check
  with `--end-of-line auto`, never mass `--write` → § Check the runbook first, first trap (generic wording), and
  runbook § Gate quirks (already there).
- db:36-37 · All E2E suites red with zero tests run is a broken client secret that kills the UI suites too →
  runbook § Red checks that aren't code bugs (already there, as an expired secret).
- db:38-41 · Two message specs failing together on clicks is a live vendor 500 popping an overlay; environmental →
  runbook § Red checks that aren't code bugs (already there, as the cart specs).
- db:41-42 · "Cleanup Old Reports" failing is a gh-pages push race, not a required check → runbook § Red checks
  (already there, as `publish-reports`).
- db:43-45 · Unit green is not boot green for `ClsService` without `ClsModule` → § Check the runbook first, second
  trap, and runbook § Gate quirks and § API rules.
- db:46-48 · `instanceof HttpErrorResponse` is always false; a spec without the interceptor proves nothing →
  runbook § Frontend rules.
- db:49-51 · A real-store describe passing after a `provideMockStore` suite may be leaked overrides → runbook §
  Frontend rules.
- db:52-53 · NG8118 fires on invoking a required input too early; fix with a deferred arrow (`linkedSignal`) →
  runbook § Frontend rules.
- db:54-55 · A broken SCSS `@use` passes lint and unit tests and fails at app build; prove it with `npx sass` →
  runbook § Gate quirks (already there) and § Frontend rules.
- db:30-32 (frame) · Check the false trails before debugging → § Check the runbook first.

### Repo facts that produce weird bugs (to the runbook)

- db:59 · A quantity can carry a trailing sign: `parseFloat('5.000-')` returns +5 → runbook § Upstream data quirks.
- db:60 · `'00000000'` is the unset date; a length-8 check yields 1899 → runbook § Upstream data quirks.
- db:61 · Flags arrive as `'X'`, `'x'`, `' X '`, `''`; a bare `=== 'X'` misreads → runbook § Upstream data quirks.
- db:62 · A fault can arrive inside an HTTP 200; read the body before trusting a 2xx → runbook § Upstream data quirks.

### Reporting

- db:66-68 · State the root cause, cite file and line, paste the verifying run; if unfixed, say what the evidence
  shows and what you ruled out → § Reporting.

## test-healer (new, not ported)

Written fresh for the starter. Its rules:

- Takes one failing test and its CI log, reproduces with the exact failing command → § Read first, § Decide.
- Reads the runbook's known-flakes list before classifying, when the profile names a runbook → § Read first.
- Decides between a real failure, a flake, and a broken locator or selector, and states the evidence → § Decide.
- A real failure is fixed in the code, or sent to the debugger, with the assertion no less strict → § Decide, 1.
- A flake is shown by repeated runs and fixed at its cause (wait for the condition, isolate state, stub a live
  dependency) → § Decide, 2.
- A broken locator is fixed to find the element a user would see, and checked to be the intended one → § Decide, 3.
- Says so, rather than guessing a category, when the evidence fits none → § Decide.
- Quarantines only with a runner-reported skip, a written reason, and a tracked follow-up, posted by the lane as one `quarantine`-marked story comment (`mcp__orbit__comment_on_story`) naming the test, the reason, and what would un-quarantine it → § Fix or quarantine, and the report.
- Never weakens an assertion → § What you never do.
- Never deletes a test or comments out its body → § What you never do.
- Never loosens a timeout or adds a retry without a written reason → § What you never do.
- Never masks a real failure as a flake without evidence → § What you never do.
- Edits only claimed files, and stops and reports when it needs another → § Claimed files, § What you never do.
- Never mass-rewrites files on a local false positive, never puts a story id in source → § What you never do.
- Reports the kind, the evidence with pass and fail counts, every change with file and line, real command output, and
  the quarantine reason and follow-up → § Report back.

## builder (generic, new)

- Takes the briefing packet and works only in the files it owns → § Read first, § Claimed files.
- Test first with `superpowers:test-driven-development`, one AC at a time, red before green → § Method.
- Stops and reports when it needs a file it wasn't given, never claims one itself → § Claimed files.
- Runs the profile's `gates.test`, and `gates.lint` and `gates.format` when present; a missing key skips the step →
  § Read first, § Gates.
- Two honest attempts at a failing gate, then reports; hard bugs go back for `orbit-starter:debugger` → § Gates.
- Never puts a story id in source, never invents a payload or endpoint, never weakens a test → § Don'ts.
- Reports file and line for every change with real command output, and any file it needed but didn't own →
  § Report back.

## New in the port

- frontend and backend gained the `Skill` grant, since they tell the lane to invoke `superpowers:test-driven-development`.
- All lanes: a "Claimed files" section carrying the story engine's rule (edit only the files the brief says are
  claimed; stop and report to get another; the story manager claims through Orbit).
- `frontend.md` and `backend.md`: a "Rules for any frontend repo" and "Rules for any backend repo" section holds the
  framework-neutral form of each source trap, so a repo without Angular or NestJS still gets it. The framework
  versions sit in a section marked as an example.
- `debugger.md`: reads the runbook's false trails, red checks, known flakes, gate quirks, and upstream data quirks
  before debugging; with no runbook it relies on the CI log.
- runbook sample: § Frontend rules, § API rules, and § Upstream data quirks.
