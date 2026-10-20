import type { Annotations, Answers, Question, QuestionReply } from '../../../../shared/types.ts';

/** What you have entered on the card for one question. */
export interface QuestionDraft {
  picked: string[];
  other: string;
  notes: string;
}

export const EMPTY_DRAFT: QuestionDraft = { picked: [], other: '', notes: '' };

/** Pick or unpick an option. A single-select pick replaces the last one and clears Other. */
export function pick(d: QuestionDraft, label: string, multi: boolean): QuestionDraft {
  if (!multi) return { ...d, picked: [label], other: '' };
  const picked = d.picked.includes(label)
    ? d.picked.filter((x) => x !== label)
    : [...d.picked, label];
  return { ...d, picked };
}

/** Type into Other. On a single-select question it replaces the pick; on a multi-select one it adds to it. */
export function typeOther(d: QuestionDraft, text: string, multi: boolean): QuestionDraft {
  return { ...d, other: text, picked: multi || !text.trim() ? d.picked : [] };
}

/** True once the question has an option picked or some Other text. */
export function answered(d: QuestionDraft): boolean {
  return d.picked.length > 0 || d.other.trim().length > 0;
}

/**
 * The reply AskUserQuestion expects: one string per question, multi-select picks comma-separated
 * with Other last, and annotations carrying your notes and the picked option's preview.
 */
export function buildReply(questions: Question[], drafts: QuestionDraft[]): QuestionReply {
  const answers: Answers = {};
  const annotations: Annotations = {};
  questions.forEach((q, i) => {
    const d = drafts[i] ?? EMPTY_DRAFT;
    const other = d.other.trim();
    answers[q.question] = q.multiSelect
      ? [...d.picked, other].filter(Boolean).join(', ')
      : other || (d.picked[0] ?? '');
    const preview =
      !q.multiSelect && !other
        ? q.options.find((o) => o.label === d.picked[0])?.preview
        : undefined;
    const notes = d.notes.trim();
    if (preview || notes)
      annotations[q.question] = { ...(preview ? { preview } : {}), ...(notes ? { notes } : {}) };
  });
  return Object.keys(annotations).length ? { answers, annotations } : { answers };
}
