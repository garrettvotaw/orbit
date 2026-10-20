import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DecisionList } from './decision-list';
import { OrbitStore } from './orbit-store';

/** Every product question across the PMs, in one place, so a stack can go to the product owner together. */
@Component({
  selector: 'orbit-decisions-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecisionList],
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
      h2 {
        margin: 0;
        font-size: 0.95rem;
        padding-right: 2.5rem;
      }
      .meta {
        color: var(--faint);
        font-size: 0.75rem;
      }
      orbit-decision-list {
        flex: 1;
        min-height: 0;
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
    @if (store.decisionsOpen()) {
      <button
        class="close"
        type="button"
        aria-label="Close decisions"
        (click)="store.decisionsOpen.set(false)"
      >
        ✕
      </button>
      <h2>Product questions</h2>
      <div class="meta">
        Raised by the PMs in plain English for the product owner. A question leaves once its answer
        has reached the PM that asked, or when you let it go.
        @if (!store.config()?.productOwnerEmail) {
          Set <code>productOwnerEmail</code> in the config for an Email button.
        }
      </div>
      <orbit-decision-list
        [items]="store.decisions()"
        [showLane]="true"
        title="All lanes"
        empty="No PM has a product question open."
      />
    }
  `,
})
export class DecisionsPanel {
  readonly store = inject(OrbitStore);
  readonly count = computed(() => this.store.openDecisions().length);
}
