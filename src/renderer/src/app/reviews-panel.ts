import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { OrbitStore } from './orbit-store';
import { formatAge } from './pure/layout';
import { reviewLaneId } from '../../../shared/review';
import type { CheckSummary, ModelOption, ReviewDecision, TeamPr } from '../../../shared/types';

const DECISION: Record<ReviewDecision, { label: string; color: string }> = {
  approved: { label: 'approved', color: '#2fb344' },
  'changes-requested': { label: 'changes requested', color: '#f59e0b' },
  'review-required': { label: 'needs review', color: '#3b82f6' },
  none: { label: 'no reviews', color: 'var(--faint)' },
};

const CHECKS: Record<CheckSummary, { label: string; color: string }> = {
  success: { label: 'CI green', color: '#2fb344' },
  failure: { label: 'CI red', color: '#ef4444' },
  pending: { label: 'CI running', color: '#3b82f6' },
  none: { label: 'no CI', color: 'var(--dim)' },
};

/** The team's open PRs, with a button that puts a review-pr session on the orbit for any of them. */
@Component({
  selector: 'orbit-reviews-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  styles: [
    `
      :host:empty {
        display: none;
      }
      :host {
        position: absolute;
        left: 1rem;
        top: 4.5rem;
        bottom: 4.5rem;
        width: min(36rem, 48vw);
        box-sizing: border-box;
        background: var(--panel-bg);
        backdrop-filter: blur(14px) saturate(1.2);
        box-shadow: var(--panel-shadow);
        isolation: isolate;
        border: 1px solid var(--edge);
        border-radius: 0.75rem;
        padding: 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
        animation: rise 0.3s ease;
        z-index: 2;
      }
      @keyframes rise {
        from {
          transform: translateY(0.5rem);
          opacity: 0;
        }
      }
      header {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding-right: 2.5rem;
      }
      h2 {
        margin: 0;
        font-size: 0.95rem;
        flex: 1;
      }
      .model {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        font-size: 0.8rem;
        color: var(--muted);
      }
      .model select {
        background: var(--bg);
        color: inherit;
        border: 1px solid var(--edge);
        border-radius: 0.4rem;
        padding: 0.25rem 0.4rem;
        max-width: 16rem;
      }
      .meta {
        color: var(--faint);
        font-size: 0.75rem;
      }
      .list {
        flex: 1;
        overflow: auto;
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        transition: opacity 0.2s ease;
      }
      .list.stale {
        opacity: 0.55;
      }
      /* The spinner sits on top of the hidden label so the button keeps its width while busy. */
      .refresh {
        display: inline-grid;
        place-items: center;
      }
      .refresh > * {
        grid-area: 1 / 1;
      }
      .refresh .hidden {
        visibility: hidden;
      }
      .spinner {
        width: 0.8rem;
        height: 0.8rem;
        border: 2px solid currentColor;
        border-right-color: transparent;
        border-radius: 50%;
        animation: spin 0.7s linear infinite;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
      .pr {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 0.3rem 0.75rem;
        align-items: center;
        background: var(--surface);
        border: 1px solid var(--edge);
        border-radius: 0.5rem;
        padding: 0.55rem 0.7rem;
      }
      .pr.asked {
        border-color: #f59e0b;
      }
      .title {
        font-size: 0.85rem;
        color: var(--text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .title button {
        background: transparent;
        border: 0;
        padding: 0;
        color: var(--link);
        text-decoration: underline;
        font: inherit;
        margin-right: 0.35rem;
      }
      .facts {
        grid-column: 1;
        display: flex;
        flex-wrap: wrap;
        gap: 0.35rem 0.6rem;
        font-size: 0.74rem;
        color: var(--muted);
        align-items: center;
      }
      .facts i {
        display: inline-block;
        width: 0.5rem;
        height: 0.5rem;
        border-radius: 50%;
        margin-right: 0.25rem;
        vertical-align: middle;
      }
      .asked-tag {
        color: #f59e0b;
        font-weight: 600;
      }
      .act {
        grid-row: 1 / span 2;
        grid-column: 2;
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        align-items: flex-end;
      }
      .act button {
        padding: 0.35rem 0.75rem;
        font-size: 0.8rem;
      }
      .act .live {
        border-color: #2fb344;
      }
      .quiet,
      .error {
        color: var(--faint);
        font-size: 0.8rem;
      }
      .error {
        color: #f59e0b;
      }
      .close {
        position: absolute;
        top: 0.5rem;
        right: 0.5rem;
        padding: 0.2rem 0.6rem;
      }
    `,
  ],
  template: `
    @if (store.reviewsOpen()) {
      <button
        class="close"
        type="button"
        aria-label="Close reviews"
        (click)="store.reviewsOpen.set(false)"
      >
        ✕
      </button>
      <header>
        <h2>Team pull requests</h2>
        <div class="model">
          <label for="review-model">Review with</label>
          <select
            id="review-model"
            name="reviewModel"
            [ngModel]="reviewModel()"
            (ngModelChange)="setReviewModel($event)"
            (focus)="store.refreshModels()"
          >
            <option value="">CLI default</option>
            @for (m of modelOptions(); track m.value) {
              <option [value]="m.value">{{ m.label }}</option>
            }
          </select>
        </div>
        <button
          class="refresh"
          type="button"
          [disabled]="refreshing()"
          [attr.aria-busy]="refreshing()"
          [attr.aria-label]="refreshing() ? 'Refreshing' : null"
          (click)="refresh()"
        >
          <span [class.hidden]="refreshing()">Refresh</span>
          @if (refreshing()) {
            <i class="spinner" aria-hidden="true"></i>
          }
        </button>
      </header>
      <div class="meta">
        {{ board().repos.length ? board().repos.join(', ') : 'repo not detected yet' }}
        @if (board().fetchedAt) {
          · fetched {{ ago(board().fetchedAt) }}
        }
        · drafts and your own PRs are left out
      </div>
      @if (board().error; as e) {
        <div class="error">{{ e }}</div>
      }
      <div class="list" role="list" aria-label="Team pull requests" [class.stale]="refreshing()">
        @for (p of board().prs; track p.repo + '#' + p.number) {
          <div
            class="pr"
            role="listitem"
            [class.asked]="p.requested === 'you'"
            [attr.aria-label]="prLabel(p) + ' ' + p.title"
          >
            <div class="title" [title]="p.title">
              <button type="button" (click)="store.open(p.url)">{{ prLabel(p) }}</button
              >{{ p.title }}
            </div>
            <div class="facts">
              <span>{{ p.author }}</span>
              <span><i [style.background]="decision(p).color"></i>{{ decision(p).label }}</span>
              <span><i [style.background]="checks(p).color"></i>{{ checks(p).label }}</span>
              <span>+{{ p.additions }} −{{ p.deletions }}</span>
              <span>{{ ago(p.updatedAt) }}</span>
              @if (p.requested === 'you') {
                <span class="asked-tag">asked for your review</span>
              } @else if (p.requested === 'team') {
                <span>team review requested</span>
              }
            </div>
            <div class="act">
              @if (laneFor(p); as lane) {
                <button type="button" class="live" (click)="store.select(lane.id)">
                  Open review · {{ lane.status }}
                </button>
              } @else {
                <button type="button" (click)="review(p)">Review</button>
              }
            </div>
          </div>
        } @empty {
          <div class="quiet">
            @if (board().fetchedAt) {
              Nothing from the team is waiting for a review.
            } @else {
              Loading the team's open PRs…
            }
          </div>
        }
      </div>
    }
  `,
})
export class ReviewsPanel {
  readonly store = inject(OrbitStore);
  readonly board = computed(() => this.store.teamPrs());
  readonly refreshing = signal(false);
  readonly reviewModel = computed(() => this.store.config()?.reviewModel ?? '');
  readonly modelOptions = computed<ModelOption[]>(() => {
    const list = [...this.store.models()];
    const current = this.reviewModel();
    if (current && !list.some((m) => m.value === current))
      list.push({ value: current, label: current });
    return list;
  });

  constructor() {
    // Opening the panel refreshes the model list so the picker is current.
    effect(() => {
      if (this.store.reviewsOpen()) void this.store.refreshModels();
    });
  }

  /** The command resolves once `gh pr list` lands, so the button stays busy for exactly that long. */
  async refresh(): Promise<void> {
    this.refreshing.set(true);
    try {
      await this.store.command({ type: 'refreshTeamPrs' });
    } finally {
      this.refreshing.set(false);
    }
  }

  setReviewModel(value: string): void {
    void this.store.command({ type: 'setReviewModel', model: value || null });
  }

  decision(p: TeamPr) {
    return DECISION[p.decision];
  }

  checks(p: TeamPr) {
    return CHECKS[p.checks];
  }

  ago(at: number): string {
    return at ? `${formatAge(this.store.now() - at)} ago` : '';
  }

  /** `#12`, or `owner/name#12` once PRs come from more than one repo. */
  prLabel(p: TeamPr): string {
    return this.board().repos.length > 1 ? `${p.repo}#${p.number}` : `#${p.number}`;
  }

  laneFor(p: TeamPr) {
    return (
      this.store
        .lanes()
        .find((l) => l.kind === 'review' && l.id === reviewLaneId(p.repo, p.number)) ?? null
    );
  }

  review(p: TeamPr): void {
    void this.store.command({ type: 'reviewPr', repo: p.repo, number: p.number });
    this.store.reviewsOpen.set(false);
    this.store.select(reviewLaneId(p.repo, p.number));
  }
}
