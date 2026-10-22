# Port checklist: the review machinery

What each rule of the sources became in the starter. One line per rule.

- `rp:N` is line N of the source review-pr skill. `sw:N` is the source pr-review-swarm SKILL.md, `fs:N` its
  finding-schema, `rs:N` its risk-size script. `ver`, `sil`, `tq`, `bl`, `au`, `dto`, `rx` are the source agents
  review-verifier, review-silent-failure, review-test-quality, review-bloat, review-auth-context, review-dto-contract,
  and review-angular-reactivity.
- Destinations: `review-pr` and `pr-review-swarm` are `skills/`, the `review-*` agents are `agents/`, "Profile" is
  `docs/repo-profile.md` (the `review` block), and "runbook" is the example runbook's Review section.
- Rulings: each agent keeps its source's tools and `model: inherit`. Repo facts become reads of the profile or the
  runbook. The upstream-mapping agent is dropped by name. People become "the user".

## review-pr

- rp:1-5 · Name, user-invocable, and description → kept; description names `/orbit-starter:review-pr`.
- rp:13-15 · `$ARGUMENTS` is a PR number, `--approve` still stops at the flag gate, no number means ask and stop → kept.
- rp:19 · Read-only on code; self-assigning is allowed → kept.
- rp:20 · No other skills → kept; names `orbit-starter:pr-review-swarm` as the user's choice, not an invocation.
- rp:21-22 · Natural tone; `gh` only → kept.
- rp:28-36 · Self-assign first; a failure isn't fatal → kept.
- rp:38-49 · Validate `gh auth status` → kept.
- rp:51-68 · Metadata, diff, commit messages → kept.
- rp:70-72 · Read the full changed files → kept.
- rp:74-86 · Optional convention doc, four paths → kept, plus the profile's runbook as a fifth path.
- rp:87-111 · Flag-and-scope check: marker lookup, current/stale/missing SHA states → kept, marked optional.
- rp:116-125 · Build a mental model first → kept.
- rp:126-139 · Review categories as prompts, not a checklist → kept.
- rp:140-155 · Simpler-path question → kept; "BFF" example becomes "the API layer".
- rp:156-175 · Workaround-should-be-a-fix, both failure modes, weighting → kept unchanged.
- rp:177-196 · Verify the flag-and-scope rows; severities per row → kept; the user-group wording → end users, the flag vendor →
  the feature-flag service.
- rp:198-206 · Finding fields and severities → kept.
- rp:207-223 · Tone rules and good/bad example → kept; the source's domain example swapped for an invoice one.
- rp:225-240 · Filtering; simpler-path and flag findings never filtered → kept.
- rp:241-254 · No findings: flag gate block, `review_preview` with an empty list under Orbit → kept.
- rp:258-306 · Numbered preview, flag gate block, remove-by-number prompt, `review_preview` payload under Orbit → kept;
  subscribe example and `featureFlagRouteGuard` line swapped for neutral ones, the named person → the user.
- rp:309-331 · Status prompt, flag gate approve confirmation, Orbit's pick is the confirmation → kept.
- rp:333-385 · One-call review post, confirm line → kept.

## pr-review-swarm

- sw:15 · Never approve, merge, or edit; `COMMENT` only → kept; the one exception is an Orbit reply naming the
  status the user picked.
- sw:16-19 · Precision over recall, never duplicate CI, evidence or silence, signal density → kept; `npm run validate`
  becomes the profile's `gates`.
- sw:21-31 · Resolve the target, local fallback → kept; fallback base is the profile's `baseBranch`.
- sw:33-41 · Claim the PR → kept.
- sw:43-67 · Risk-size, depth table, split on `deep` over ~40 files, honor `--agents` → kept; the split is by
  top-level area, not the source repo's two app names.
- sw:69-75 · Diff to the session workspace → kept.
- sw:77-98 · Parallel dispatch, scoped file lists, one retry → kept; roster is the starter's agents under
  `orbit-starter:`; the bloat dispatch also passes `sizeBands`.
- sw:81-89 · upstream-mapping row → dropped: named in the plan. Its buckets fold into `contract`/`integration`.
- sw:100-117 · Collect, assign ids, verify, apply verdicts → kept.
- sw:119-125 · Dedupe, rank, cap → kept.
- sw:127-155 · Local preview format, "No blocking issues" → kept; example swapped for an invoice one.
- sw:157-161 · Ask before posting, default important only → kept; the `ask_user` tool becomes asking in chat, or
  `review_preview` under Orbit.
- sw:163-205 · One review payload, `COMMENT` only, 422 fallback to a top-level comment → kept.
- sw:207-209 · Re-review convergence → kept.
- sw:211-215 · Notes, REVIEW.md → kept; adds the profile and runbook as the home for repo facts.
- fs:1-62 · Finding and verifier schema, severity meaning, reporting rules → kept; the `important` list is generic
  and the agent name is the prefixed one.
- rs:1-70 · Weighted buckets, first match wins, zero weight means skip → kept as defaults; repo paths (feature-auth,
  util-cls, mule-apis, mappers) dropped for generic globs, and `review.riskGlobs` goes first.
- rs:72-107 · Glob converter, classify → kept; `{a,b}` support added.
- rs:109-154 · PR and base-diff readers → kept; base defaults to the profile's `baseBranch`.
- rs:156-194 · Depth bands, analysis → kept.
- rs:196-218 · Bucket to agents map, bloat dropped under 150 → kept with the renamed roster; the mapping bucket and
  `realtime` buckets dropped, `integration` added.
- rs:220-290 · CLI, `--json` and table output → kept; `--profile` added; JSON carries `sizeBands`.

## Agents

- ver:10-18 · Precision stage, read-only, bias toward rejection, verify independently → kept.
- ver:20-47 · Verdicts, eight rejection rules, downgrade rules → kept; `npm run validate` becomes the repo's gates.
- ver:49-51 · Confidence re-score, under 60 rejected → kept.
- ver:53-59 · Repo-specific care → kept generic: flag values, client-asserted identity, handle leaks, contract
  consumers, bloat recount.
- ver:61-86 · JSON output → kept.
- sil:10-16 · Silent failure framing, one class only → kept.
- sil:18-58 · Six hunt categories → kept; Upstream-system, identity-header, and framework-logger wording becomes "upstream", "identity
  headers", "the repo's structured logger".
- sil:60-90 · Evidence standard, diff scope, output → kept.
- tq:10-18 · Tests that pass loudly, one class only → kept.
- tq:20-48 · Cannot-fail tests, behavioral coverage, fixture hygiene → kept; the upstream flag edge cases move to the
  runbook.
- tq:50-61 · Playwright rules → kept as defaults the runbook overrides; Per-app POM and fixture
  specifics dropped to "the repo's shape".
- tq:63-99 · Independence, evidence, diff scope, output → kept.
- bl:16-26 · Percentile table measured from the source repo → replaced: the profile's `review.sizeBands`, else the
  agent measures the repo's own percentiles with a given command.
- bl:28-39 · Report growth, not pre-existing size → kept, using the bands.
- bl:41-62 · Function, component, service thresholds → kept; function lines replaceable by `functionNit` and
  `functionImportant`; the component and service sections are marked as framework examples.
- bl:64-102 · Also-worth-flagging, evidence standard, cap of five, output → kept.
- au:16-22 · The central rule → generalized from the request-context key and identity header to "client-asserted identity".
- au:24-61 · Five hunt categories → kept; the two cited precedent files become "look in the repo for precedent".
- au:63-93 · Evidence, diff scope, output → kept.
- dto:10-47 · Passthrough, fragmentation, contract breaks → kept; the mandate is read from the repo's own `CLAUDE.md`
  and runbook rather than assumed. Agent renamed `review-contract`.
- dto:49-93 · Layer violations, doc drift, validation gaps → kept; server alias imports become "server-only
  packages".
- rx:10-72 · Leaked subscriptions, change detection, template, DI, signals, state, styling → kept, marked an Angular
  example; project rules apply only where the runbook says the repo adopted them. Agent renamed `review-reactivity`.
- rx:51-55 · `effect()` rule → kept, widened to also flag `.set()`/`.update()` inside an effect (the current Angular
  guidance), since `allowSignalWrites` no longer matters.
- rx:74-94 · Diff scope, output → kept.
- Upstream-mapping agent (all) · Dropped: named in the plan.
