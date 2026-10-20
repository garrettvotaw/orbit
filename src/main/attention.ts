import { randomUUID } from 'node:crypto';
import type {
  Annotations,
  Answers,
  AttentionItem,
  ErrorCode,
  Question,
  QuestionReply,
  TrackerRef,
} from '../shared/types.ts';

interface Pending {
  resolve: (r: QuestionReply) => void;
  reject: (e: Error) => void;
  unsubscribe: () => void;
}

const KIND_ORDER: Record<AttentionItem['kind'], number> = { question: 0, blocked: 1, error: 2 };

export class AttentionQueue {
  readonly #list: AttentionItem[] = [];
  readonly #pending = new Map<string, Pending>();
  readonly #listeners = new Set<() => void>();
  readonly #now: () => number;
  readonly #newId: () => string;

  constructor(opts: { now?: () => number; newId?: () => string } = {}) {
    this.#now = opts.now ?? Date.now;
    this.#newId = opts.newId ?? randomUUID;
  }

  items(): AttentionItem[] {
    return [...this.#list].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.raisedAt - b.raisedAt);
  }

  onChange(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  ask(
    laneId: string,
    toolUseId: string,
    questions: Question[],
    why: string | null,
    signal?: AbortSignal,
  ): Promise<QuestionReply> {
    const id = this.#newId();
    this.#list.push({ id, laneId, kind: 'question', raisedAt: this.#now(), toolUseId, questions, why });
    this.#emit();
    return new Promise<QuestionReply>((resolve, reject) => {
      const onAbort = () =>
        this.#settle(id, undefined, new Error('aborted: lane ended before the question was answered'));
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(id, { resolve, reject, unsubscribe: () => signal?.removeEventListener('abort', onAbort) });
      if (signal?.aborted) onAbort();
    });
  }

  /** Settle a question; annotations ride along only when there are some. */
  answer(id: string, answers: Answers, annotations?: Annotations): boolean {
    if (!this.#pending.has(id)) return false;
    this.#settle(id, annotations && Object.keys(annotations).length ? { answers, annotations } : { answers });
    return true;
  }

  raiseBlocked(
    laneId: string,
    story: string,
    decision: string,
    say: { text?: string | null; options?: Array<{ label: string; reply: string }> } = {},
  ): string {
    const id = this.#newId();
    this.#list.push({
      id,
      laneId,
      kind: 'blocked',
      raisedAt: this.#now(),
      story,
      decision,
      text: say.text ?? null,
      options: say.options ?? [],
    });
    this.#emit();
    return id;
  }

  raiseError(laneId: string, code: ErrorCode, message: string, tracker?: TrackerRef): string {
    const id = this.#newId();
    this.#list.push({
      id,
      laneId,
      kind: 'error',
      raisedAt: this.#now(),
      code,
      message,
      ...(tracker ? { tracker } : {}),
    });
    this.#emit();
    return id;
  }

  dismiss(id: string): void {
    if (this.#pending.has(id)) this.#settle(id, undefined, new Error('dismissed'));
    else this.#remove(id);
  }

  clearLane(laneId: string): void {
    for (const item of [...this.#list]) {
      if (item.laneId !== laneId) continue;
      if (this.#pending.has(item.id)) this.#settle(item.id, undefined, new Error('lane cleared'));
      else this.#remove(item.id);
    }
  }

  /** Drop a lane's blocked items, for example once you have replied to it. Questions stay. */
  clearBlocked(laneId: string): void {
    for (const item of [...this.#list]) if (item.laneId === laneId && item.kind === 'blocked') this.#remove(item.id);
  }

  #settle(id: string, reply?: QuestionReply, error?: Error): void {
    const p = this.#pending.get(id);
    this.#pending.delete(id);
    p?.unsubscribe();
    this.#remove(id);
    if (!p) return;
    if (error) p.reject(error);
    else p.resolve(reply ?? { answers: {} });
  }

  #remove(id: string): void {
    const i = this.#list.findIndex((x) => x.id === id);
    if (i !== -1) {
      this.#list.splice(i, 1);
      this.#emit();
    }
  }

  #emit(): void {
    for (const l of this.#listeners) l();
  }
}
