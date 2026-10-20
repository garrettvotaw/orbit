import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { OrbitStore } from './orbit-store';
import type { RingDot, RingSegment } from './pure/ring';

/** How long a dot that left the ring stays to be seen falling into the core. */
const DROP_MS = 650;

/**
 * A donut around a core: one arc per state, optional dots for the items inside each arc,
 * and a dashed outline when the lane has gone quiet. A dot that moves slides to its new arc;
 * one that leaves (a merged PR, a closed story) shrinks into the core.
 */
@Component({
  selector: 'g[orbit-ring]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      .arc {
        fill: none;
        transition:
          stroke-dasharray 0.5s ease,
          stroke-dashoffset 0.5s ease;
      }
      .dot {
        cursor: pointer;
        transition:
          cx 0.5s ease,
          cy 0.5s ease,
          r 0.3s ease;
      }
      .dot:hover {
        stroke: var(--text);
        stroke-width: 2;
      }
      .gone {
        pointer-events: none;
        animation: drop 0.65s ease-in forwards;
      }
      @keyframes drop {
        to {
          transform: translate(var(--dx), var(--dy)) scale(0.2);
          opacity: 0;
        }
      }
    `,
  ],
  template: `
    <svg:circle
      [attr.r]="radius()"
      fill="none"
      stroke="var(--edge)"
      [attr.stroke-width]="width()"
      opacity="0.6"
    />
    @if (stale()) {
      <svg:circle
        [attr.r]="radius() + width()"
        fill="none"
        stroke="var(--dim)"
        stroke-width="1.5"
        stroke-dasharray="4 6"
        pointer-events="none"
      >
        <svg:title>Quiet for over two hours</svg:title>
      </svg:circle>
    }
    <svg:g transform="rotate(-90)">
      @for (s of segments(); track s.key) {
        <svg:circle
          class="arc"
          [attr.r]="radius()"
          [attr.stroke]="s.color"
          [attr.stroke-width]="width()"
          [attr.stroke-dasharray]="s.dasharray"
          [attr.stroke-dashoffset]="s.dashoffset"
          stroke-linecap="butt"
        >
          <svg:title>{{ s.label }} · {{ s.count }}</svg:title>
        </svg:circle>
      }
    </svg:g>
    @for (d of dots(); track d.id) {
      <svg:circle
        class="dot"
        [attr.cx]="d.x"
        [attr.cy]="d.y"
        [attr.r]="dotRadius()"
        [attr.fill]="d.color"
        stroke="var(--bg)"
        stroke-width="1"
        role="link"
        tabindex="0"
        [attr.aria-label]="d.title"
        (click)="store.open(d.url); $event.stopPropagation()"
        (keydown.enter)="store.open(d.url)"
      >
        <svg:title>{{ d.title }}</svg:title>
      </svg:circle>
    }
    @for (g of ghosts(); track g.id) {
      <svg:circle
        class="gone"
        aria-hidden="true"
        [attr.cx]="g.x"
        [attr.cy]="g.y"
        [attr.r]="dotRadius()"
        [attr.fill]="g.color"
        [style.--dx]="-g.x + 'px'"
        [style.--dy]="-g.y + 'px'"
      />
    }
  `,
})
export class LaneRing {
  readonly store = inject(OrbitStore);
  readonly radius = input.required<number>();
  readonly width = input(7);
  readonly segments = input<RingSegment[]>([]);
  readonly dots = input<RingDot[]>([]);
  readonly dotRadius = input(4.5);
  readonly stale = input(false);
  /** Dots that just left the ring, kept briefly so they can be seen dropping into the core. */
  readonly ghosts = signal<RingDot[]>([]);
  #seen: RingDot[] = [];

  constructor() {
    effect(() => {
      const now = this.dots();
      const ids = new Set(now.map((d) => d.id));
      const gone = this.#seen.filter((d) => !ids.has(d.id));
      this.#seen = now;
      // Everything leaving at once is the lane losing focus, not items closing.
      if (!gone.length || !now.length) return;
      this.ghosts.update((g) => [...g, ...gone]);
      setTimeout(() => this.ghosts.update((g) => g.filter((d) => !gone.includes(d))), DROP_MS);
    });
  }
}
