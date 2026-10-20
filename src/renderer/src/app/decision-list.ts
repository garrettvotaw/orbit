import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { OrbitStore } from './orbit-store';
import { formatAge } from './pure/layout';
import { forProductOwner, mailtoProductOwner } from '../../../shared/po-text';
import type { Decision } from '../../../shared/types';

/**
 * Product questions waiting on an answer, with the ways to clear them: pick a choice the PM
 * offered, type an answer, let one go, or pass the whole stack to the product owner.
 */
@Component({
  selector: 'orbit-decision-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        min-height: 0;
      }
      header {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        flex-wrap: wrap;
      }
      h3 {
        margin: 0;
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--muted);
        flex: 1;
      }
      header button {
        padding: 0.25rem 0.65rem;
        font-size: 0.75rem;
      }
      .list {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        overflow: auto;
        min-height: 0;
      }
      .q {
        background: var(--surface);
        border: 1px solid var(--edge);
        border-left: 3px solid #a78bfa;
        border-radius: 0.5rem;
        padding: 0.55rem 0.7rem;
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
      }
      .q.sent {
        border-left-color: #3b82f6;
      }
      .answer .waits {
        color: var(--faint);
        font-weight: 400;
        margin-left: 0.3rem;
      }
      .answer .let-go {
        margin-left: 0.4rem;
      }
      .q.answered {
        border-left-color: #2fb344;
        opacity: 0.75;
      }
      .ask {
        font-size: 0.9rem;
        color: var(--text);
        font-weight: 600;
        line-height: 1.35;
      }
      .ask .num {
        color: #a78bfa;
        margin-right: 0.35rem;
      }
      .line {
        font-size: 0.78rem;
        color: var(--text-2);
        line-height: 1.35;
      }
      .line b {
        color: var(--muted);
        font-weight: 600;
        margin-right: 0.3rem;
      }
      .meta {
        font-size: 0.72rem;
        color: var(--faint);
        display: flex;
        gap: 0.6rem;
        flex-wrap: wrap;
      }
      .meta .sent-tag {
        color: var(--link);
      }
      .choices {
        display: flex;
        flex-wrap: wrap;
        gap: 0.35rem;
      }
      .choices button {
        padding: 0.3rem 0.7rem;
        font-size: 0.78rem;
        border-color: var(--edge-strong);
        text-align: left;
      }
      .choices button:hover {
        border-color: #a78bfa;
      }
      .choices button.rec {
        border-color: #a78bfa;
      }
      .reply {
        display: flex;
        gap: 0.4rem;
        align-items: center;
      }
      .reply input {
        flex: 1;
        min-width: 0;
        background: var(--bg);
        color: inherit;
        border: 1px solid var(--edge);
        border-radius: 0.4rem;
        padding: 0.35rem 0.5rem;
        font: inherit;
        font-size: 0.8rem;
      }
      .reply button {
        padding: 0.3rem 0.7rem;
        font-size: 0.78rem;
      }
      .let-go {
        background: transparent;
        border: 0;
        color: var(--faint);
        padding: 0.2rem 0.3rem;
        font-size: 0.72rem;
        text-decoration: underline;
      }
      .answer {
        font-size: 0.8rem;
        color: #2fb344;
      }
      .quiet {
        color: var(--faint);
        font-size: 0.8rem;
      }
    `,
  ],
  template: `
    <header>
      <h3>{{ title() }}{{ open().length ? ' · ' + open().length : '' }}</h3>
      @if (open().length) {
        <button
          type="button"
          (click)="copy()"
          title="Copy every open question as plain text and mark them sent"
        >
          {{ copied() ? 'Copied' : 'Copy for PO' }}
        </button>
        @if (email(); as to) {
          <button
            type="button"
            (click)="mail(to)"
            title="Open a mail to the product owner with every open question"
          >
            Email PO
          </button>
        }
      }
    </header>
    <div class="list" role="list" [attr.aria-label]="title()">
      @for (d of items(); track d.id) {
        <div
          class="q"
          role="listitem"
          [class.sent]="d.status === 'open' && d.sentAt"
          [class.answered]="d.status === 'answered'"
          [attr.aria-label]="'Q' + d.n + ' ' + d.question"
        >
          <div class="ask">
            <span class="num">Q{{ d.n }}</span
            >{{ d.question }}
          </div>
          <div class="line"><b>Today</b>{{ d.today }}</div>
          @if (d.proposed) {
            <div class="line"><b>Proposed</b>{{ d.proposed }}</div>
          }
          <div class="meta">
            @if (showLane()) {
              <span>{{ d.laneName }}</span>
            }
            @if (d.story) {
              <span>story {{ d.story }}</span>
            }
            <span>asked {{ ago(d.askedAt) }}</span>
            @if (d.status === 'open' && d.sentAt) {
              <span class="sent-tag">sent to PO {{ ago(d.sentAt) }}</span>
            }
          </div>
          @if (d.status === 'answered') {
            <div class="answer">
              Answered: {{ d.answer }}
              <span class="waits">· reaches {{ d.laneName }} when it is next between turns</span>
              <button
                class="let-go"
                type="button"
                (click)="letGo(d)"
                title="Drop it; the lane will not hear the answer"
              >
                forget
              </button>
            </div>
          } @else {
            @if (d.options.length) {
              <div class="choices" role="group" [attr.aria-label]="'Choices for Q' + d.n">
                @for (o of d.options; track o; let i = $index) {
                  <button
                    type="button"
                    [class.rec]="i === 0"
                    [title]="i === 0 ? 'The PM recommends this' : ''"
                    (click)="answer(d, o)"
                  >
                    {{ o }}
                  </button>
                }
              </div>
            }
            <div class="reply">
              <input
                type="text"
                [attr.aria-label]="'Answer Q' + d.n"
                placeholder="Your answer…"
                [ngModel]="drafts()[d.id] ?? ''"
                (ngModelChange)="draft(d.id, $event)"
                (keydown.enter)="answer(d, drafts()[d.id] ?? '')"
              />
              <button
                type="button"
                [disabled]="!(drafts()[d.id] ?? '').trim()"
                (click)="answer(d, drafts()[d.id] ?? '')"
              >
                Answer
              </button>
              <button
                class="let-go"
                type="button"
                (click)="letGo(d)"
                title="Drop the question; the PM goes with its recommendation"
              >
                let it go
              </button>
            </div>
          }
        </div>
      } @empty {
        <div class="quiet">{{ empty() }}</div>
      }
    </div>
  `,
})
export class DecisionList {
  readonly store = inject(OrbitStore);
  readonly items = input.required<Decision[]>();
  readonly title = input('Product questions');
  readonly empty = input('No product questions waiting.');
  readonly showLane = input(false);
  readonly open = computed(() => this.items().filter((d) => d.status === 'open'));
  readonly email = computed(() => this.store.config()?.productOwnerEmail ?? null);
  readonly drafts = signal<Record<string, string>>({});
  readonly copied = signal(false);

  ago(at: number): string {
    return `${formatAge(this.store.now() - at)} ago`;
  }

  draft(id: string, text: string): void {
    this.drafts.update((d) => ({ ...d, [id]: text }));
  }

  answer(d: Decision, text: string): void {
    const answer = text.trim();
    if (!answer) return;
    void this.store.command({ type: 'answerDecision', id: d.id, answer });
    this.drafts.update(({ [d.id]: _gone, ...rest }) => rest);
  }

  letGo(d: Decision): void {
    void this.store.command({ type: 'dismissDecision', id: d.id });
  }

  copy(): void {
    const list = this.open();
    void this.store.command({ type: 'copyText', text: forProductOwner(list) });
    void this.store.command({ type: 'markDecisionsSent', ids: list.map((d) => d.id) });
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 2000);
  }

  mail(to: string): void {
    const list = this.open();
    this.store.open(mailtoProductOwner(to, list));
    void this.store.command({ type: 'markDecisionsSent', ids: list.map((d) => d.id) });
  }
}
