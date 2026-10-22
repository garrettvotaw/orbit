// Reads the repo profile and fills in the stack defaults. The profile lives at .claude/orbit/repo.json in the repo
// root. A missing file or a missing `stack` key is not an error here: the caller decides whether the stack is on.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const STACK_DEFAULTS = {
  spine: ['package.json', 'package-lock.json'],
  maxPrsPerRun: 3,
};

export function loadProfile(repoRoot) {
  const file = path.join(repoRoot || '.', '.claude', 'orbit', 'repo.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function stackConfig(profile) {
  const s = (profile && profile.stack) || {};
  return {
    enabled: s.enabled === true,
    graph: s.graph || null,
    layers: s.layers || [],
    spine: s.spine || STACK_DEFAULTS.spine,
    verify: s.verify || null,
    cutRoot: s.cutRoot || null,
    maxPrsPerRun: s.maxPrsPerRun || STACK_DEFAULTS.maxPrsPerRun,
  };
}

/**
 * The command that proves one slice builds on its own. `{base}` is the ref the slice is stacked on. Callers run it in
 * the slice's own worktree (its base plus that slice only). With no `stack.verify` the default is the profile's lint
 * and test gates, which only prove a build if the test command compiles everything; a repo whose test command
 * doesn't should set `stack.verify` to its build-and-test command.
 */
export function verifyCommandFor(profile, baseRef) {
  const cfg = stackConfig(profile);
  if (cfg.verify) return cfg.verify.split('{base}').join(baseRef);
  const gates = (profile && profile.gates) || {};
  // Format checks are left out on purpose: CI is the authority on formatting.
  const parts = [gates.lint, gates.test].filter(Boolean);
  return parts.length ? parts.join(' && ') : null;
}

/** The prefix a stack's branches share, from the profile. */
export function branchPrefix(profile) {
  return (profile && profile.prefix) || 'stack';
}

const CLOSING_KEYWORD = /^\s*(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s*/i;

/**
 * How a PR or slice title names the story, from the profile's prLink. Only the slice that completes the story may
 * close it. Pass `closes: false` for every other slice and a leading closing keyword is stripped, so the link
 * references the story without closing it.
 */
export function storyLink(profile, story, { closes = true } = {}) {
  if (!story) return '';
  const link = ((profile && profile.prLink) || '{id}').split('{id}').join(story);
  return closes ? link : link.replace(CLOSING_KEYWORD, '');
}
