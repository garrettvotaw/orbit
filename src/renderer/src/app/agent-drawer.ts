import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { FeedView } from './feed-view';
import { OrbitStore } from './orbit-store';
import type { FeedEntry } from '../../../shared/types';

/** A clean feed for one agent or the PM: text, tool one-liners, results folded away. */
@Component({
  selector: 'orbit-agent-drawer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FeedView],
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
        width: min(32rem, 44vw);
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
        gap: 0.5rem;
        animation: rise 0.3s ease;
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
      orbit-feed-view {
        flex: 1;
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
    @if (store.drawer(); as d) {
      <button
        class="close"
        type="button"
        aria-label="Close transcript"
        (click)="store.drawer.set(null)"
      >
        ✕
      </button>
      <header>
        <h2>{{ d.title }}</h2>
        <button type="button" (click)="load()" [disabled]="loading()">Refresh</button>
      </header>
      <orbit-feed-view
        role="log"
        [attr.aria-label]="'Transcript for ' + d.title"
        aria-live="polite"
        [entries]="entries()"
        [note]="note()"
        [loading]="loading()"
        [conversation]="d.laneId + ':' + (d.agentId ?? 'pm')"
      />
    }
  `,
})
export class AgentDrawer {
  readonly store = inject(OrbitStore);
  readonly entries = signal<FeedEntry[]>([]);
  readonly note = signal<string | null>(null);
  readonly loading = signal(false);
  #request = 0;

  constructor() {
    effect(() => {
      const d = this.store.drawer();
      this.entries.set([]);
      this.note.set(null);
      if (d) void this.load();
    });
    // The PM's own feed grows while the drawer is open; follow it.
    effect(() => {
      const d = this.store.drawer();
      const lane = d ? this.store.lanes().find((l) => l.id === d.laneId) : null;
      lane?.feedCount;
      if (d && d.agentId === null && lane) void this.load();
    });
  }

  async load(): Promise<void> {
    const d = this.store.drawer();
    if (!d) return;
    const seq = ++this.#request;
    this.loading.set(true);
    try {
      const res = await this.store.feed(d.laneId, d.agentId);
      if (seq !== this.#request || this.store.drawer() !== d) return;
      this.entries.set(res.entries);
      this.note.set(res.note);
    } catch (e) {
      this.note.set(`Could not load: ${(e as Error).message}`);
    } finally {
      if (seq === this.#request) this.loading.set(false);
    }
  }
}
