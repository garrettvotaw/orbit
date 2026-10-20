import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal } from '@angular/core';
import { OrbitStore } from './orbit-store';
import { FeedView } from './feed-view';
import { QuestionCard } from './question-card';
import type { AttentionItem, BlockedItem, ErrorItem, TrackerKind } from '../../../shared/types';

const TRACKER_NAME: Record<TrackerKind, string> = { ado: 'ADO', jira: 'Jira', github: 'GitHub' };

const ERROR_TITLE: Record<ErrorItem['code'], string> = {
  exit: 'session ended',
  api: 'API error',
  'aws-sso': 'AWS SSO expired',
  'tracker-auth': 'Tracker sign-in expired',
  memory: 'Memory almost out',
};

@Component({
  selector: 'orbit-attention-rail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [QuestionCard, FeedView],
  styles: [
    `
      :host {
        position: absolute;
        top: 1rem;
        left: 1rem;
        display: flex;
        gap: 0.75rem;
        align-items: flex-start;
        max-width: 60vw;
        z-index: 3;
      }
      .beacon {
        width: 1.1rem;
        height: 1.1rem;
        border-radius: 50%;
        background: #f59e0b;
        margin-top: 0.3rem;
        position: relative;
        flex: none;
      }
      .beacon::after {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: 50%;
        border: 2px solid #f59e0b;
        animation: ring 1.6s ease-out infinite;
      }
      @keyframes ring {
        to {
          transform: scale(2.4);
          opacity: 0;
        }
      }
      /* The home row sits at 55% of the stage; a tall card scrolls rather than covering a core. */
      .body {
        max-height: calc(55vh - 9rem);
        overflow-y: auto;
        overscroll-behavior: contain;
      }
      .card {
        background: var(--panel-bg);
        backdrop-filter: blur(14px) saturate(1.2);
        box-shadow: var(--panel-shadow);
        isolation: isolate;
        border: 1px solid var(--edge);
        border-radius: 0.75rem;
        padding: 0.75rem 1rem;
        width: min(28rem, 90vw);
      }
      .card.blocked {
        border-color: #f59e0b;
      }
      .card.error {
        border-color: #ef4444;
      }
      .say {
        margin-top: 0.5rem;
        max-height: 14rem;
        border: 1px solid var(--edge);
        border-radius: 0.5rem;
        padding: 0.5rem 0.6rem;
        background: var(--bg);
      }
      .options {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
        margin-top: 0.6rem;
      }
      .options button {
        padding: 0.35rem 0.8rem;
        font-size: 0.8rem;
        border-color: #f59e0b;
        text-align: left;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
        margin-top: 0.5rem;
      }
      .chip {
        font-size: 0.75rem;
        background: var(--surface);
        border: 1px solid var(--edge);
        border-radius: 999px;
        padding: 0.15rem 0.6rem;
        color: var(--muted);
      }
      .actions {
        display: flex;
        gap: 0.5rem;
        justify-content: flex-end;
        margin-top: 0.5rem;
      }
      .sign-in {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        margin-top: 0.5rem;
      }
      .sign-in input {
        flex: 1 1 10rem;
        min-width: 0;
      }
      .quiet {
        color: var(--faint);
        font-size: 0.75rem;
        margin-top: 0.4rem;
      }
      .compact {
        text-align: left;
        max-width: 34rem;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        border-color: #f59e0b;
        color: var(--text);
        font-size: 0.8rem;
      }
      .more {
        flex: none;
        color: #f59e0b;
        border-color: #f59e0b;
        font-size: 0.8rem;
        margin-left: -0.4rem;
      }
      .chip:hover {
        border-color: #f59e0b;
        color: var(--text);
      }
    `,
  ],
  template: `
    @if (current(); as item) {
      <div class="beacon" role="status" aria-label="Something needs you"></div>
      @if (compact()) {
        <button
          class="compact"
          type="button"
          (click)="expand()"
          [attr.aria-label]="'Show: ' + headline(item)"
        >
          {{ headline(item) }}
        </button>
        @if (store.attention().length > 1) {
          <button
            class="more"
            type="button"
            title="Next"
            [attr.aria-label]="'Next of ' + store.attention().length"
            (click)="next()"
          >
            +{{ store.attention().length - 1 }}
          </button>
        }
      } @else {
        <div class="body">
          @switch (item.kind) {
            @case ('question') {
              <orbit-question-card [item]="item" />
            }
            @case ('blocked') {
              <div class="card blocked">
                <strong>
                  @if (item.text) {
                    {{ laneName(item) }} is waiting on you
                  } @else {
                    {{ laneName(item) }} is blocked on {{ item.story }}
                  }
                </strong>
                @if (item.text) {
                  <orbit-feed-view
                    class="say"
                    [attr.aria-label]="'What ' + laneName(item) + ' said'"
                    [entries]="[{ kind: 'text', text: item.text, tool: null }]"
                    [followTail]="false"
                  />
                } @else {
                  <p>{{ item.decision }}</p>
                }
                @if (item.options.length) {
                  <div class="options" role="group" aria-label="Answer">
                    @for (o of item.options; track o.reply) {
                      <button
                        type="button"
                        [title]="'Sends: ' + o.reply"
                        (click)="reply(item, o.reply)"
                      >
                        {{ o.label }}
                      </button>
                    }
                  </div>
                }
                <div class="actions">
                  <button
                    type="button"
                    (click)="store.command({ type: 'dismiss', attentionId: item.id })"
                  >
                    Dismiss
                  </button>
                  <button type="button" (click)="store.select(item.laneId)">Reply in lane</button>
                </div>
              </div>
            }
            @case ('error') {
              <div class="card error">
                <!-- Memory is the whole machine's, not the lane it is filed under. -->
                <strong>
                  @if (item.code !== 'memory') {
                    {{ laneName(item) }}:
                  }
                  {{ errorTitle(item) }}</strong
                >
                <p>{{ item.message }}</p>
                @if (item.code === 'tracker-auth' && item.tracker?.kind === 'jira') {
                  <form
                    class="sign-in"
                    aria-label="Jira sign-in"
                    (submit)="saveJira($event, item, jiraEmail.value, jiraToken.value)"
                  >
                    <input
                      #jiraEmail
                      type="email"
                      placeholder="Email"
                      aria-label="Jira email"
                      autocomplete="username"
                    />
                    <input
                      #jiraToken
                      type="password"
                      placeholder="API token"
                      aria-label="Jira API token"
                      autocomplete="current-password"
                    />
                    <button type="submit">Save</button>
                  </form>
                }
                <div class="actions">
                  <button
                    type="button"
                    (click)="store.command({ type: 'dismiss', attentionId: item.id })"
                  >
                    Dismiss
                  </button>
                  @if (item.code === 'aws-sso') {
                    <button
                      type="button"
                      (click)="store.command({ type: 'ssoLogin', laneId: item.laneId })"
                    >
                      AWS SSO login
                    </button>
                  }
                  @if (item.code === 'tracker-auth') {
                    @if (item.tracker?.kind !== 'jira') {
                      <button
                        type="button"
                        (click)="store.command({ type: 'trackerLogin', laneId: item.laneId })"
                      >
                        {{ item.tracker?.kind === 'github' ? 'gh auth login' : 'az login' }}
                      </button>
                    }
                    <button type="button" (click)="refreshBoard(item)">Retry board</button>
                  } @else if (item.code !== 'memory') {
                    <button type="button" (click)="resume(item)">Resume</button>
                  }
                </div>
              </div>
            }
          }
          @if (others().length) {
            <div class="chips">
              @for (other of others(); track other.id) {
                <button class="chip" type="button" [title]="headline(other)" (click)="show(other)">
                  {{ laneName(other) }} · {{ other.kind }}
                </button>
              }
            </div>
          }
        </div>
      }
    } @else {
      <div class="quiet">Nothing needs you.</div>
    }
  `,
})
export class AttentionRail {
  readonly store = inject(OrbitStore);
  /** While a panel owns the left side (transcript, reviews), fold the card down to one line. */
  readonly compact = computed(
    () => !!this.store.drawer() || this.store.reviewsOpen() || this.store.decisionsOpen(),
  );
  /** The item on show: the oldest until you step to another, and kept while it is still open. */
  readonly #shownId = linkedSignal<AttentionItem[], string | null>({
    source: () => this.store.attention(),
    computation: (items, prev) =>
      prev && items.some((i) => i.id === prev.value) ? prev.value : (items[0]?.id ?? null),
  });
  readonly current = computed(
    () =>
      this.store.attention().find((i) => i.id === this.#shownId()) ??
      this.store.attention()[0] ??
      null,
  );
  readonly others = computed(() => this.store.attention().filter((i) => i !== this.current()));

  /** Step to the next item, wrapping round to the oldest. */
  next(): void {
    const items = this.store.attention();
    const at = items.findIndex((i) => i.id === this.current()?.id);
    this.#shownId.set(items[(at + 1) % items.length]?.id ?? null);
  }

  show(i: AttentionItem): void {
    this.#shownId.set(i.id);
  }

  headline(i: AttentionItem): string {
    const lane = this.laneName(i);
    if (i.kind === 'question')
      return `${lane} is asking: ${i.questions[0]?.question ?? i.questions[0]?.header ?? ''}`;
    if (i.kind === 'blocked') return `${lane} is blocked on ${i.story}`;
    return `${lane}: ${this.errorTitle(i)}`;
  }

  expand(): void {
    this.store.drawer.set(null);
    this.store.reviewsOpen.set(false);
    this.store.decisionsOpen.set(false);
  }

  laneName(i: AttentionItem): string {
    return this.store.lanes().find((l) => l.id === i.laneId)?.name ?? i.laneId;
  }

  errorTitle(i: ErrorItem): string {
    if (i.code === 'tracker-auth' && i.tracker)
      return `${TRACKER_NAME[i.tracker.kind]} sign-in expired`;
    return ERROR_TITLE[i.code];
  }

  /** Send the picked answer and follow it into the lane; the host drops the nudge on send. */
  reply(i: BlockedItem, text: string): void {
    void this.store.command({ type: 'send', laneId: i.laneId, text, priority: 'next' });
    this.store.select(i.laneId);
  }

  resume(i: ErrorItem): void {
    void this.store.command({ type: 'resume', laneId: i.laneId });
    void this.store.command({ type: 'dismiss', attentionId: i.id });
  }

  saveJira(e: Event, i: ErrorItem, email: string, token: string): void {
    e.preventDefault();
    if (!i.tracker || !email.trim() || !token.trim()) return;
    void this.store.command({ type: 'saveJiraLogin', site: i.tracker.site, email, token });
  }

  refreshBoard(i: ErrorItem): void {
    void this.store.command({ type: 'refreshBoard', laneId: i.laneId });
    void this.store.command({ type: 'dismiss', attentionId: i.id });
  }
}
