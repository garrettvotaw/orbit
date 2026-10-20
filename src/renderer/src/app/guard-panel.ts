import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { OrbitStore } from './orbit-store';
import { barFraction, formatFree, memoryColor, panelRows } from './pure/guard';

/**
 * The corner card above the legend: how much memory is free, who holds the test slots and for how
 * long, and who is in line or held for memory.
 */
@Component({
  selector: 'orbit-guard-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { role: 'status', 'aria-label': 'Memory and test slots' },
  styles: [
    `
      :host {
        display: block;
        min-width: 14rem;
        color: var(--muted);
        font-size: 0.75rem;
        background: var(--panel-bg);
        backdrop-filter: blur(14px) saturate(1.2);
        box-shadow: var(--panel-shadow);
        isolation: isolate;
        border: 1px solid var(--edge);
        border-radius: 0.5rem;
        padding: 0.5rem 0.75rem;
      }
      .line {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        margin: 0.15rem 0;
        font-family: var(--mono);
      }
      .free {
        color: var(--text);
      }
      .bar {
        height: 0.375rem;
        border-radius: 0.2rem;
        background: color-mix(in srgb, var(--muted) 20%, transparent);
        overflow: hidden;
        margin: 0.25rem 0 0.4rem;
      }
      .bar i {
        display: block;
        height: 100%;
        transition: width 0.6s ease;
      }
      .pip {
        display: inline-block;
        width: 0.5rem;
        height: 0.5rem;
        border-radius: 50%;
        background: #7c5cff;
        box-shadow: 0 0 0.375rem #7c5cff;
        margin-right: 0.35rem;
        vertical-align: middle;
      }
      .wait {
        opacity: 0.8;
      }
    `,
  ],
  template: `
    <div class="line">
      <span>memory</span><span class="free" [style.color]="tone()">{{ free() }}</span>
    </div>
    <div class="bar"><i [style.width.%]="lit()" [style.background]="tone()"></i></div>
    @for (r of rows(); track $index) {
      <div class="line" [class.wait]="r.kind === 'wait'">
        <span>
          @if (r.kind === 'slot') {
            <i class="pip"></i>
          } @else {
            ⏳
          }
          {{ r.who }}
        </span>
        <span>{{ r.what }}</span>
      </div>
    }
  `,
})
export class GuardPanel {
  readonly #store = inject(OrbitStore);
  readonly free = computed(() =>
    formatFree(this.#store.guard().headroomBytes, this.#store.guard().state),
  );
  readonly tone = computed(() => memoryColor(this.#store.guard().state));
  readonly lit = computed(() => Math.round(barFraction(this.#store.guard()) * 100));
  readonly rows = computed(() =>
    panelRows(this.#store.guard(), this.#store.lanes(), this.#store.now()),
  );
}
