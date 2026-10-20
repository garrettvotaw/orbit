import type { Decision } from './types.ts';

/** Plain text for pasting to the product owner, one numbered block per question. */
export function forProductOwner(list: Decision[], at = Date.now()): string {
  const day = new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const blocks = list.map((d, i) => {
    const lines = [`${i + 1}. ${d.question}`, `   Today: ${d.today}`];
    if (d.proposed) lines.push(`   Proposed: ${d.proposed}`);
    if (d.options.length)
      lines.push(`   Options: ${d.options.map((o, k) => (k === 0 ? `${o} (recommended)` : o)).join(' / ')}`);
    lines.push(`   From: ${d.laneName}${d.story ? ` · story ${d.story}` : ''}`);
    return lines.join('\n');
  });
  return [`Product questions from the Truck Care rebuild — ${day}`, '', ...blocks].join('\n\n');
}

/** A mail link with the same text, for the Email button. */
export function mailtoProductOwner(email: string, list: Decision[], at = Date.now()): string {
  const subject = `${list.length} product question${list.length === 1 ? '' : 's'} from the Truck Care rebuild`;
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(forProductOwner(list, at))}`;
}
