import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  linkedSignal,
  output,
  signal,
} from '@angular/core';
import { planReview } from '../../../shared/review';
import {
  pickTitle,
  reviewReply,
  type Decision,
  type ReviewPrompt,
  type ReviewResult,
} from './pure/review-prompt';

const DECISIONS: Array<{ id: Decision; label: string }> = [
  { id: 'approve', label: 'Approve' },
  { id: 'request', label: 'Request changes' },
  { id: 'leave', label: 'Comment only' },
];

/**
 * One-click answers to the review-pr skill's preview: untick the comments to drop, then pick
 * the review status, and Orbit posts the review itself. What Orbit cannot post (a preview with no
 * comment text, changes requested with nothing to say) goes back to the skill as one message, and
 * so does a review GitHub refused, at the click of Let Claude post it.
 */
@Component({
  selector: 'orbit-review-actions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { role: 'group', 'aria-label': 'Review actions' },
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        flex: 0 1 auto;
        min-height: 0;
        max-height: 50%;
        background: var(--surface);
        border: 1px solid #f59e0b;
        border-radius: 0.6rem;
        padding: 0.6rem 0.75rem;
      }
      h3 {
        margin: 0;
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: #f59e0b;
      }
      .chips {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        flex: 1 1 auto;
        min-height: 0;
        overflow: auto;
        overflow-x: hidden;
        padding-right: 0.25rem;
      }
      .chip {
        display: grid;
        grid-template-columns: auto auto 1fr;
        gap: 0.45rem;
        align-items: baseline;
        font-size: 0.8rem;
        cursor: pointer;
      }
      .chip input {
        margin: 0;
        align-self: center;
      }
      .chip.dropped .what {
        text-decoration: line-through;
        color: var(--faint);
      }
      .sev {
        font-size: 0.7rem;
        padding: 0.05rem 0.4rem;
        border-radius: 999px;
        border: 1px solid var(--edge);
        color: var(--muted);
      }
      .sev.critical,
      .sev.major {
        color: #f59e0b;
        border-color: #f59e0b;
      }
      .what {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--text-2);
      }
      .what small {
        display: block;
        color: var(--muted);
        font-size: 0.72rem;
        white-space: normal;
      }
      .decide {
        display: flex;
        gap: 0.4rem;
        flex-wrap: wrap;
      }
      .decide button {
        padding: 0.35rem 0.8rem;
        font-size: 0.8rem;
      }
      .decide .approve {
        border-color: #2fb344;
      }
      .decide .request {
        border-color: #ef4444;
      }
      .hint {
        color: var(--faint);
        font-size: 0.72rem;
      }
      .error {
        margin: 0;
        color: #ef4444;
        font-size: 0.78rem;
      }
    `,
  ],
  template: `
    <h3>
      {{ prompt().findings.length ? 'Post which comments, and what status?' : 'What status?' }}
    </h3>
    @if (prompt().findings.length) {
      <div class="chips">
        @for (f of prompt().findings; track f.n) {
          <label class="chip" [class.dropped]="dropped().has(f.n)">
            <input type="checkbox" [checked]="!dropped().has(f.n)" (change)="toggle(f.n)" />
            <span class="sev" [class]="'sev ' + f.severity">{{ f.severity }}</span>
            <span class="what" [title]="f.file + ':' + f.line">
              {{ f.n }}. {{ shortFile(f.file) }}:{{ f.line }}
              @if (f.gist) {
                <small>{{ f.gist }}</small>
              }
            </span>
          </label>
        }
      </div>
    }
    <div class="decide">
      @for (d of decisions; track d.id) {
        <button
          type="button"
          [class]="d.id"
          [title]="titleFor(d.id)"
          [disabled]="busy()"
          (click)="pick(d.id)"
        >
          {{ d.label }}
        </button>
      }
    </div>
    @if (failure(); as f) {
      <p class="error" role="alert">GitHub did not take the review: {{ f.error }}</p>
      <div class="decide">
        <button type="button" (click)="send.emit(replyFor(f.pick))">Let Claude post it</button>
      </div>
    }
    @if (prompt().findings.length) {
      <span class="hint"
        >{{ kept() }} of {{ prompt().findings.length }} comments will be posted</span
      >
    }
  `,
})
export class ReviewActions {
  readonly prompt = input.required<ReviewPrompt>();
  /** How Orbit's post of this review went, once you picked a status. */
  readonly result = input<ReviewResult | null>(null);
  /** A message for the skill: what Orbit cannot post, or the fallback after GitHub refused. */
  readonly send = output<string>();
  /** Your pick, for Orbit to post itself. */
  readonly post = output<{ dropped: number[]; pick: Decision }>();
  /** A post on its way; any outcome ends it. */
  readonly busy = linkedSignal({ source: this.result, computation: () => false });
  readonly failure = computed(() => {
    const r = this.result();
    return r && !r.ok ? r : null;
  });
  readonly decisions = DECISIONS;
  readonly dropped = signal<ReadonlySet<number>>(new Set());
  readonly kept = computed(
    () => this.prompt().findings.filter((f) => !this.dropped().has(f.n)).length,
  );

  toggle(n: number): void {
    const next = new Set(this.dropped());
    if (next.has(n)) next.delete(n);
    else next.add(n);
    this.dropped.set(next);
  }

  pick(decision: Decision): void {
    if (planReview(this.prompt(), this.dropped(), decision).kind === 'cannot') {
      this.send.emit(this.replyFor(decision));
      return;
    }
    this.busy.set(true);
    this.post.emit({ dropped: [...this.dropped()], pick: decision });
  }

  titleFor(decision: Decision): string {
    return pickTitle(this.prompt(), new Set(this.dropped()), decision);
  }

  replyFor(decision: Decision): string {
    return reviewReply(this.prompt(), new Set(this.dropped()), decision);
  }

  shortFile(file: string): string {
    const parts = file.split('/');
    return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : file;
  }
}
