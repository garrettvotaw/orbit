import { ORBIT_STAGES, type ProjectConfig, type TrackerConfig, type TrackerRef } from '../../shared/types.ts';

/** A project's tracker: its `tracker` block, else its legacy `ado` block read as one, else none. */
export function trackerOf(p: ProjectConfig): TrackerConfig | null {
  if (p.tracker) return p.tracker;
  if (p.ado) return { kind: 'ado', org: p.ado.org, project: p.ado.project, anchorId: p.ado.anchorId };
  return null;
}

/** The sign-in a tracker uses. */
export function refOf(t: TrackerConfig): TrackerRef {
  if (t.kind === 'ado') return { kind: 'ado', site: t.org };
  if (t.kind === 'jira') return { kind: 'jira', site: t.site };
  return { kind: 'github', site: 'github.com' };
}

const exactlyOne = (a: unknown, b: unknown) => (a !== undefined) !== (b !== undefined);

/** Throws on a tracker block Orbit couldn't poll, naming the project. */
export function validateTracker(t: TrackerConfig, projectId: string): void {
  const fail = (why: string) => {
    throw new Error(`config: project "${projectId}" tracker ${why}`);
  };
  if (t.kind === 'ado') {
    if (!t.org || !t.project || typeof t.anchorId !== 'number') fail('needs org, project, and anchorId');
  } else if (t.kind === 'jira') {
    if (!t.site || !t.projectKey || typeof t.board !== 'number') fail('needs site, projectKey, and board');
    if (!exactlyOne(t.epic, t.jql)) fail('needs exactly one of epic or jql');
  } else if (t.kind === 'github') {
    if (!t.repo) fail('needs repo');
    if (!exactlyOne(t.project, t.label)) fail('needs exactly one of project or label');
  } else {
    fail(`has an unknown kind "${(t as { kind?: unknown }).kind}"`);
  }
  for (const [column, stage] of Object.entries(t.stages ?? {})) {
    if (!ORBIT_STAGES.includes(stage)) fail(`maps "${column}" to "${stage}", which is not an Orbit stage`);
  }
}
