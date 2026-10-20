import type { ProjectConfig } from '../../../../shared/types.ts';

/**
 * The board a PM made in New orbit starts with: the first project's ADO org and project with no
 * anchor yet, as it always has; nothing when the first project isn't on ADO, so it isn't refused.
 */
export function newProjectBoard(projects: ProjectConfig[]): Pick<ProjectConfig, 'ado'> {
  const ado = projects[0]?.ado;
  return ado ? { ado: { org: ado.org, project: ado.project, anchorId: 0 } } : {};
}
