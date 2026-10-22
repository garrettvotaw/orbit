# Port checklist: the optional pieces

What each rule of qa-tester, test-data-scout, and stack became in the starter. `qa:N` and `tds:N` are line N of the
source agents. Stack rules are named by the source SKILL section or script. All live in the source user's own config,
outside this repo.

Destinations: `qa-tester.md` and `test-data-scout.md` are `agents/`. `stack/` is `skills/stack/`. `runbook` is
`examples/nx-web-api/.claude/orbit/runbook.md`, section QA. "Profile" is `docs/repo-profile.md`.

Rulings: each piece runs only when the profile turns it on (`qa.enabled`, `consults.testData`, `stack.enabled`). Tools
and `model: inherit` are kept, ADO tools become the Orbit board tools. Company, environment, and person facts become
reads of the runbook or profile.

## qa-tester

- qa:3-5 · Description, tools, `model: inherit` -> kept. ADO query, read, comment, and state tools -> `get_story`,
  `list_board`, `comment_on_story`, `move_story`, plus `attach_to_story`. Playwright MCP stays absent.
- qa:10-13 · Judge whether a user gets the AC behavior, not whether tests pass -> intro.
- qa:15-20 · Cannot Edit; Write only for the report and own scripts under the staging folder -> intro.
- qa:22-39 · Coordinates table (URLs, credentials file, workflow, report and harness paths) -> "Coordinates come from
  the runbook", runbook QA section. Prod never touched -> kept. Missing credentials file means stop -> kept.
- qa:41-48 · Scripts with node on the harness, never the Playwright MCP -> "You drive the browser with scripts".
- qa:50-64 · Real environment, everything persists; stay on the AC path; paper trail of records touched -> "The one
  thing that makes this job different". Added: write only where the runbook marks safe.
- qa:68-96 · Resolve the item, list candidates, three-story cap, empty AC means stop, DRIFT for impossible AC ->
  Phase 1. Candidate query -> `list_board` with `qa.testStates`.
- qa:98-129 · Deploy gate and its three outcomes, run id in the report, affected-set wrinkle -> Phase 2.
  Workflow name -> `qa.deployWorkflow`. PR search by the story reference -> profile `prLink`.
- qa:131-146 · AC to test plan table, NOT-OBSERVABLE up front -> Phase 3.
- qa:148-178 · Stage harness, login, never write a password, read flags, note the site -> Phase 4.
- qa:180-212 · Per-AC scripts, selectors from the template, shots, evidence, FAIL needs log and repro, rerun once ->
  Phase 5.
- qa:214-239 · Five verdicts, BLOCKED is not a soft FAIL, rule-outs -> Phase 6.
- qa:241-284 · Report template and top-level verdict rule -> Phase 7.
- qa:286-321 · Gated outward writes: draft, wait, forward-only moves, comment is a summary, PR comment after approval
  -> Phase 8. Added: attaching screenshots needs the same yes.
- qa:323-330 · Stop-and-ask list -> kept, plus "profile or runbook missing".
- qa:332-338 · Voice -> kept.
- dropped: the story-ID-in-source warning (qa:317-318) is a user memory, not a QA rule, and the starter has no
  story ids in source anyway.

## test-data-scout

- tds:3-5 · Description, tools, model -> kept. The internal API-docs MCP tools are dropped (company server); the
  Postman read tools are kept; integration docs come from the runbook.
- tds:10-17 · Purpose and authority to build -> intro.
- tds:19-35 · Coordinates -> "Coordinates come from the runbook". Never touch other environments, never put the
  password anywhere, missing credentials file means stop -> kept.
- tds:37-64 · Method steps 1-7 (predicates, registry, endpoint, harness login, verify from body, build, write
  registry, mark stale and never delete) -> Method.
- tds:66-85 · Endpoint catalog -> the runbook's endpoint catalog; the method says to confirm routes in the controller.
- tds:87-124 · Build via the app API first, upstream via Postman fallback, dev-only, secrets redacted, read the body
  after a write, don't build on shared data, stop after two failed writes -> Building a scenario.
- tds:126-142 · Traps -> generic ones in Traps; repo-specific ones go to the runbook.
- tds:144-151 · What you return -> kept.
- tds:153-162 · Rules: writes only to the safe environment, Postman read-only, no repo edits, cite responses, two
  failed logins -> Rules. "dev only" became "the environment the runbook names as safe for test data".

## stack

- SKILL "Never reason from memory, read disk" and the three state files -> Is it on, and the registry paths.
- SKILL rule 1 (merge only when the gate passes) -> rule 1. Rule 2 (never force-push) -> rule 2. Rule 3 (never check
  out in the integration worktree) -> rule 3. Rule 4 (no format check as a slice gate) -> rule 4, now defers to the
  runbook. Rule 5 (.stack never owned, integration never merges) -> rule 5. Rule 6 -> rule 6. Rule 7 -> rule 7.
- SKILL "autonomous merge, no second ask" -> changed: rule 8, merging follows the profile's `merge` key (ask by
  default), matching the other skills. Flagged in the report.
- SKILL start (read story, worktree, copy env files, sketch, register, tell user) -> start. ADO read -> `get_story`;
  copy and link -> `orbit-starter:worktree-bootstrap`; register snippet -> `stack.js register`.
- SKILL plan (stop on unassigned, multiOwned, spine keys, unmapped; report spineConflicts and drift; show the DAG
  before writing; under-constrained DAG) -> plan.
- SKILL materialize (union check, verify each slice standalone, open only when all green, cap 3 PRs, PR body, move the
  story once) -> materialize. Cap -> `stack.maxPrsPerRun`. Parallel verify -> one `Agent` per slice in one message,
  replacing the Workflow tool. Story move -> `move_story`.
- SKILL status, fix, sync, finish -> same sections. Running ADO comment rewrite -> `comment_on_story` marker `stack`.
  Resolved state on finish -> `move_story` with the stage the PM's brief names.
- SKILL demo capture and attach -> Demo capture. Attach -> `attach_to_story`.
- SKILL waiting without burning tokens, resuming cold -> kept. The hook that auto-launched a shepherd per PR is gone,
  so the cap's reason is now "don't hand the monitor a burst".
- references/state-schema.md, troubleshooting.md -> kept, de-specialized. adoState and adoCommentId -> `trackerStage`
  and the comment marker.
- scripts/manifest.js, spine.js, gate.js, state.js, reconcile.js, demo.js -> ported to ES modules. Hard-coded
  `main` -> profile `baseBranch`. Owner and repo -> registry or `gh repo view`. Story link in titles -> `prLink`.
- scripts/plan.js -> layers come from `stack.layers`, the graph from `stack.graph` (an nx adapter is built in).
  Hard-coded layer names, the type- and api- folder conventions, and the spine allowlist moved to the profile.
- scripts/materialize.js -> `git` now runs with argument arrays; branch name from `prefix`; cutting folder from
  `stack.cutRoot`; verify command from `stack.verify` or the gates.
- scripts/stack.js -> new commands: register, unregister, body, demo (the source did these inline or not at all).
- dropped: the `/hello` resume mention. The starter has no such skill. Resume is "run registry and status".
