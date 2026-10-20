import {
  ChangeDetectionStrategy,
  Component,
  HostBinding,
  computed,
  inject,
  signal,
} from '@angular/core';
import { OrbitStore } from './orbit-store';
import { formatAge } from './pure/layout';
import { firstProblem, noteGist, stagePips, type StagePip } from './pure/pr-notes';
import { boardGroups, mentionsKey, prGroups } from './pure/ring';
import type { PrLane, TrackerItem } from '../../../shared/types';

/** The split view: ADO state columns for a project, or the PR table for the monitor. */
@Component({
  selector: 'orbit-board-columns',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        position: absolute;
        top: 4.5rem;
        bottom: 4.5rem;
        left: 34%;
        right: calc(min(26rem, 38vw) + 2rem);
        display: flex;
        gap: 0.6rem;
        overflow-x: auto;
        padding-bottom: 0.5rem;
        animation: slide-in 0.4s ease;
      }
      :host(.wide) {
        left: 29%;
      }
      @keyframes slide-in {
        from {
          transform: translateX(2rem);
          opacity: 0;
        }
      }
      .col {
        flex: 1 1 10rem;
        min-width: 10rem;
        background: var(--panel-bg);
        backdrop-filter: blur(14px) saturate(1.2);
        box-shadow: var(--panel-shadow);
        isolation: isolate;
        border: 1px solid var(--edge);
        border-radius: 0.75rem;
        padding: 0.6rem;
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        overflow: auto;
      }
      .col h3 {
        margin: 0 0 0.2rem;
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        display: flex;
        align-items: center;
        gap: 0.4rem;
      }
      .col h3 i {
        width: 0.6rem;
        height: 0.6rem;
        border-radius: 50%;
        display: inline-block;
      }
      .card {
        text-align: left;
        background: var(--surface);
        border: 1px solid var(--edge);
        border-left-width: 3px;
        border-radius: 0.4rem;
        padding: 0.4rem 0.5rem;
        font-size: 0.8rem;
        line-height: 1.3;
      }
      .card.working {
        border-left-color: #2fb344;
      }
      .card b {
        color: var(--muted);
        font-weight: 600;
        margin-right: 0.3rem;
      }
      .card small {
        display: block;
        color: var(--faint);
        margin-top: 0.15rem;
      }
      .table {
        flex: 1 1 auto;
        background: var(--panel-bg);
        backdrop-filter: blur(14px) saturate(1.2);
        box-shadow: var(--panel-shadow);
        isolation: isolate;
        border: 1px solid var(--edge);
        border-radius: 0.75rem;
        padding: 0.6rem;
        overflow: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.8rem;
      }
      th {
        text-align: left;
        color: var(--muted);
        font-weight: 600;
        padding: 0.3rem 0.4rem;
        border-bottom: 1px solid var(--edge);
      }
      td {
        padding: 0.35rem 0.4rem;
        border-bottom: 1px solid var(--surface);
        vertical-align: top;
      }
      td.prcell {
        max-width: 11rem;
      }
      td .title {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: var(--text-2);
      }
      td.gates {
        white-space: nowrap;
      }
      .pips {
        display: inline-flex;
        gap: 0.25rem;
        margin-bottom: 0.15rem;
      }
      .pips i {
        display: inline-block;
        width: 0.65rem;
        height: 0.65rem;
        border-radius: 50%;
      }
      td.gates small {
        display: block;
        font-size: 0.72rem;
      }
      td.gates small.ok {
        color: #2fb344;
      }
      td.now {
        min-width: 12rem;
      }
      td.now .status {
        color: var(--text);
      }
      td.now .gist {
        color: var(--muted);
        font-size: 0.76rem;
        margin-top: 0.1rem;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .more {
        background: transparent;
        border: 0;
        padding: 0;
        margin-top: 0.15rem;
        font-size: 0.72rem;
        color: var(--faint);
        text-decoration: underline;
      }
      tr.note-row td {
        color: var(--muted);
        font-size: 0.76rem;
        line-height: 1.45;
        white-space: pre-wrap;
        background: var(--bg);
        border-left: 2px solid var(--edge);
        padding: 0.6rem 0.8rem;
      }
      .activity-head {
        margin: 0.8rem 0 0.3rem;
        font-size: 0.75rem;
        color: var(--muted);
      }
      .activity {
        font-size: 0.78rem;
        color: var(--text-2);
        padding: 0.2rem 0;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .activity .ago {
        color: var(--faint);
      }
      .pr {
        background: transparent;
        border: 0;
        padding: 0;
        color: var(--link);
        text-decoration: underline;
      }
      .bucket {
        display: inline-block;
        padding: 0.05rem 0.5rem;
        border-radius: 999px;
        font-size: 0.72rem;
        color: var(--bg);
        font-weight: 600;
      }
      .stale {
        color: #f59e0b;
        font-size: 0.75rem;
        margin-bottom: 0.4rem;
      }
      .empty {
        color: var(--faint);
        font-size: 0.85rem;
        padding: 1rem;
      }
    `,
  ],
  template: `
    @if (store.selectedLane(); as lane) {
      @if (lane.kind === 'project') {
        @if (board(); as b) {
          @if (b.stale) {
            <div class="stale">Board is stale ({{ b.error }}) · showing the last good fetch</div>
          }
        }
        @for (g of columns(); track g.key) {
          <section class="col" [attr.aria-label]="g.label + ' column'">
            <h3><i [style.background]="g.color"></i>{{ g.label }} · {{ g.items.length }}</h3>
            @for (it of g.items; track it.id) {
              <button
                class="card"
                type="button"
                [class.working]="isWorked(it.key)"
                (click)="store.open(it.url)"
              >
                <b>{{ it.key }}</b
                >{{ it.title }}
                @if (it.prs.length) {
                  <small>PR {{ prList(it) }}</small>
                }
              </button>
            }
          </section>
        } @empty {
          <div class="empty">No open stories under this board yet.</div>
        }
      } @else {
        <div class="table">
          @if (prBoard(); as b) {
            <table aria-label="Pull requests">
              <thead>
                <tr>
                  <th>PR</th>
                  <th>Gates</th>
                  <th>Bucket</th>
                  <th>Now</th>
                </tr>
              </thead>
              <tbody>
                @for (l of prLanes(); track l.number) {
                  <tr>
                    <td class="prcell">
                      <button class="pr" type="button" (click)="store.open(l.url)">
                        #{{ l.number }}
                      </button>
                      <div class="title" [title]="l.title">{{ l.title }}</div>
                    </td>
                    <td class="gates">
                      <div class="pips" role="img" [attr.aria-label]="gatesLabel(l)">
                        @for (p of pips(l); track p.key) {
                          <i [style.background]="p.color" [title]="p.title"></i>
                        }
                      </div>
                      @if (problem(l); as p) {
                        <small [style.color]="p.color">{{ p.key }}: {{ p.label || p.state }}</small>
                      } @else {
                        <small class="ok">all green</small>
                      }
                    </td>
                    <td>
                      <span class="bucket" [style.background]="bucketColor(l.bucket)">{{
                        l.bucket
                      }}</span>
                    </td>
                    <td class="now">
                      <div class="status">{{ l.status }}</div>
                      @if (gist(l); as g) {
                        <div class="gist" [title]="g">{{ g }}</div>
                      }
                      @if (l.note && l.note !== gist(l)) {
                        <button
                          class="more"
                          type="button"
                          [attr.aria-expanded]="expanded().has(l.number)"
                          (click)="toggleNote(l.number)"
                        >
                          {{ expanded().has(l.number) ? 'hide note' : 'full note' }}
                        </button>
                      }
                    </td>
                  </tr>
                  @if (expanded().has(l.number)) {
                    <tr class="note-row">
                      <td colspan="4">{{ l.note }}</td>
                    </tr>
                  }
                } @empty {
                  <tr>
                    <td colspan="4" class="empty">No open PRs in the monitor's state.</td>
                  </tr>
                }
              </tbody>
            </table>
            @if (b.activity.length) {
              <h3 class="activity-head">Recent activity</h3>
              @for (a of b.activity.slice(-6).reverse(); track a.at) {
                <div class="activity" [title]="a.text">
                  <span class="ago">{{ ago(a.at) }}</span> · {{ a.text }}
                </div>
              }
            }
          } @else {
            <div class="empty">The monitor has not written state.json yet.</div>
          }
        </div>
      }
    }
  `,
})
export class BoardColumns {
  readonly store = inject(OrbitStore);
  readonly expanded = signal<ReadonlySet<number>>(new Set());

  @HostBinding('class.wide') get wide(): boolean {
    return this.store.selectedLane()?.kind === 'monitor';
  }

  toggleNote(n: number): void {
    this.expanded.update((s) => {
      const next = new Set(s);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  }

  readonly board = computed(() => {
    const lane = this.store.selectedLane();
    return lane ? this.store.boardFor(lane.id) : null;
  });
  readonly prBoard = computed(() => {
    const lane = this.store.selectedLane();
    return lane ? this.store.prBoardFor(lane.id) : null;
  });
  readonly columns = computed(() => boardGroups(this.board()));
  readonly prLanes = computed(() => prGroups(this.prBoard()?.lanes ?? []).flatMap((g) => g.items));
  readonly #workedKeys = computed(() => {
    const lane = this.store.selectedLane();
    const text = (lane?.agents ?? [])
      .filter((a) => a.state === 'working')
      .map((a) => `${a.description} ${a.summary ?? ''}`)
      .join(' ');
    return new Set(
      (this.board()?.items ?? []).map((i) => i.key).filter((k) => mentionsKey(text, k)),
    );
  });

  isWorked(key: string): boolean {
    return this.#workedKeys().has(key);
  }

  prList(it: TrackerItem): string {
    return it.prs.map((p) => `#${p.number}`).join(', ');
  }

  bucketColor(bucket: string): string {
    return prGroups([{ bucket } as PrLane])[0]?.color ?? '#9aa3b2';
  }

  pips(l: PrLane): StagePip[] {
    return stagePips(l.stages);
  }

  problem(l: PrLane): StagePip | null {
    return firstProblem(l.stages);
  }

  gatesLabel(l: PrLane): string {
    return stagePips(l.stages)
      .map((p) => p.title)
      .join(', ');
  }

  gist(l: PrLane): string | null {
    return noteGist(l.note);
  }

  ago(at: number): string {
    return at ? `${formatAge(this.store.now() - at)} ago` : '';
  }
}
