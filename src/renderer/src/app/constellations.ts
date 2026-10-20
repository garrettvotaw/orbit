import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
  signal,
} from '@angular/core';
import type { LaneKind, Star } from '../../../shared/types';
import { OrbitStore } from './orbit-store';
import {
  arrivals,
  placeGalaxy,
  starTint,
  type PmGalaxy,
  type SkyStar,
} from './pure/constellations';
import { stageKeepOut, starLook } from './pure/galaxy';
import { ORBIT_TILT } from './pure/layout';
import { leanFor } from './pure/stars';
import { worldFor } from './pure/worlds';

/** Where a home lane sits on the stage right now, how big its core is, and how far its moons reach. */
export interface SkyAnchor {
  pmId: string;
  kind: LaneKind;
  x: number;
  y: number;
  core: number;
  reach: number;
}

/** A core where the home row came to rest, which PR stars keep clear of. */
export interface RestingCore {
  x: number;
  y: number;
  r: number;
}

interface Sky extends PmGalaxy {
  tint: string;
  /** Where a merge's star launches from: the PR monitor's core, or its PM's moon ring without one. */
  origin: { x: number; y: number };
}

const sameIds = (a: Star[], b: Star[]) =>
  a.length === b.length && a.every((s, i) => s.id === b[i].id);

const TIP_W = 230;

/**
 * The sprint's merges in the Milky Way: one star per PR merged on a PM's stories this sprint,
 * tinted from its planet and scattered along the band, last sprint's smaller and dimmer. The more
 * that merge, the smaller they get, so a busy sprint reads as coloured dust. A PR that merges
 * while you watch goes supernova at the PR monitor and the spark flies to its star.
 */
@Component({
  selector: 'g[orbit-constellations]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'constellations', '[class.away]': 'away()', '[style.transform]': 'lean()' },
  styles: [
    `
      :host {
        transition:
          opacity 0.6s ease,
          transform 0.9s cubic-bezier(0.2, 0.8, 0.2, 1);
      }
      :host(.away) {
        opacity: 0;
        pointer-events: none;
      }
      .faded {
        fill: var(--tint);
        opacity: 0.65;
      }
      .star {
        cursor: pointer;
        outline: none;
      }
      .dot {
        fill: var(--tint);
        transform-box: fill-box;
        transform-origin: center;
        transition: transform 0.15s ease;
      }
      .flare {
        stroke: var(--tint);
        stroke-width: 1;
        fill: none;
      }
      .ring {
        fill: none;
        stroke: var(--tint);
        stroke-width: 1.2;
        opacity: 0;
      }
      .newest .ring {
        animation: newest 3s ease-in-out infinite;
      }
      .star:hover .dot,
      .star:focus-visible .dot {
        transform: scale(1.5);
      }
      .hit {
        fill: transparent;
      }
      @keyframes newest {
        0%,
        100% {
          opacity: 0.3;
        }
        50% {
          opacity: 0.8;
        }
      }
      /* A PR merging: a burst at the PR monitor, a spark flying up, the star lighting. */
      .arriving .dot {
        animation: ignite 2.4s ease-out both;
      }
      .burst {
        fill: none;
        stroke: #fde68a;
        stroke-width: 2;
        transform-box: fill-box;
        transform-origin: center;
        animation: burst 1.1s ease-out both;
      }
      .core-flash {
        fill: #fff7d6;
        transform-box: fill-box;
        transform-origin: center;
        animation: flash 0.9s ease-out both;
      }
      .spark {
        fill: #fff7d6;
        animation: rise 1s 0.45s cubic-bezier(0.3, 0, 0.2, 1) both;
      }
      @keyframes burst {
        from {
          transform: scale(0.2);
          opacity: 1;
        }
        to {
          transform: scale(2.4);
          opacity: 0;
        }
      }
      @keyframes flash {
        from {
          transform: scale(1);
          opacity: 1;
        }
        to {
          transform: scale(0.2);
          opacity: 0;
        }
      }
      @keyframes rise {
        from {
          transform: translate(var(--dx), var(--dy));
          opacity: 1;
        }
        90% {
          opacity: 1;
        }
        to {
          transform: translate(0, 0);
          opacity: 0;
        }
      }
      @keyframes ignite {
        0%,
        55% {
          transform: scale(0);
        }
        75% {
          transform: scale(1.8);
        }
        to {
          transform: scale(1);
        }
      }
      .tip rect {
        fill: var(--panel-bg);
        stroke: var(--tint);
        stroke-opacity: 0.6;
      }
      .tip text {
        fill: var(--text);
        font-size: 12px;
      }
      .tip .sub {
        fill: var(--muted);
      }
    `,
  ],
  template: `
    <svg:defs>
      <svg:radialGradient id="galaxy-well">
        <svg:stop offset="0%" style="stop-color: var(--stage-bg)" stop-opacity="0.75" />
        <svg:stop offset="100%" style="stop-color: var(--stage-bg)" stop-opacity="0" />
      </svg:radialGradient>
      @for (sky of skies(); track sky.pmId) {
        <svg:radialGradient [attr.id]="'galaxy-glow-' + sky.pmId">
          <svg:stop offset="0%" [attr.stop-color]="sky.tint" stop-opacity="1" />
          <svg:stop offset="100%" [attr.stop-color]="sky.tint" stop-opacity="0" />
        </svg:radialGradient>
      }
    </svg:defs>
    @for (sky of skies(); track sky.pmId) {
      <svg:g class="pm" [style.--tint]="sky.tint" [attr.data-pm]="sky.pmId">
        @for (s of sky.faded; track s.id) {
          <svg:circle
            [attr.cx]="s.x"
            [attr.cy]="s.y"
            [attr.r]="look().faint * 5.5"
            [attr.fill]="'url(#galaxy-glow-' + sky.pmId + ')'"
            [attr.opacity]="fadedGlow()"
          />
          <svg:circle class="faded" [attr.cx]="s.x" [attr.cy]="s.y" [attr.r]="look().faint" />
        }
        @for (s of sky.lit; track s.id) {
          <svg:g
            class="star"
            role="link"
            tabindex="0"
            [class.newest]="s.newest"
            [class.arriving]="arriving().has(s.id)"
            [attr.transform]="'translate(' + s.x + ',' + s.y + ')'"
            [attr.aria-label]="label(s)"
            (mouseenter)="hovered.set(s)"
            (mouseleave)="hovered.set(null)"
            (focus)="hovered.set(s)"
            (blur)="hovered.set(null)"
            (click)="open(s)"
            (keydown.enter)="open(s)"
          >
            @if (arriving().has(s.id)) {
              <svg:circle
                class="core-flash"
                [attr.cx]="sky.origin.x - s.x"
                [attr.cy]="sky.origin.y - s.y"
                r="7"
              />
              <svg:circle
                class="burst"
                [attr.cx]="sky.origin.x - s.x"
                [attr.cy]="sky.origin.y - s.y"
                r="14"
              />
              <svg:circle
                class="spark"
                r="2.4"
                [style.--dx.px]="sky.origin.x - s.x"
                [style.--dy.px]="sky.origin.y - s.y"
              />
            }
            @if (look().presence > 0.15) {
              <svg:circle
                class="well"
                [attr.r]="look().size * 3.3"
                fill="url(#galaxy-well)"
                [attr.opacity]="look().presence"
              />
            }
            <svg:circle
              class="glow"
              [attr.r]="look().size * 5.5"
              [attr.fill]="'url(#galaxy-glow-' + sky.pmId + ')'"
              [attr.opacity]="litGlow()"
            />
            @if (flarePath(); as d) {
              <svg:path class="flare" [attr.d]="d" [attr.opacity]="0.45 * look().presence" />
            }
            <svg:circle class="ring" [attr.r]="look().size * 2.2 + 5" />
            <svg:circle class="dot" [attr.r]="look().size" />
            <svg:circle class="hit" [attr.r]="look().hit" />
          </svg:g>
        }
      </svg:g>
    }
    @if (tip(); as t) {
      <svg:g
        class="tip"
        aria-hidden="true"
        [style.--tint]="t.tint"
        [attr.transform]="'translate(' + t.x + ',' + t.y + ')'"
      >
        <svg:rect [attr.width]="tipWidth" height="40" rx="6" />
        <svg:text x="10" y="16">{{ t.line1 }}</svg:text>
        <svg:text class="sub" x="10" y="32">{{ t.line2 }}</svg:text>
      </svg:g>
    }
  `,
})
export class Constellations {
  readonly #store = inject(OrbitStore);
  readonly anchors = input.required<SkyAnchor[]>();
  /** Where the home row's cores came to rest; stars keep off them without dodging mid-glide. */
  readonly cores = input<RestingCore[]>([]);
  readonly width = input(1200);
  readonly height = input(800);
  /** Where the pointer is, -1..1 from the middle; the stars lean the other way with the band. */
  readonly tilt = input({ x: 0, y: 0 });
  readonly #lean = computed(() => leanFor(this.tilt(), 'far'));
  readonly lean = computed(() => `translate(${this.#lean().x}px, ${this.#lean().y}px)`);
  readonly hovered = signal<SkyStar | null>(null);
  readonly tipWidth = TIP_W;

  /** The focus view moves the cores, so the stars step aside until you are back on the home row. */
  readonly away = computed(() => this.#store.selectedLaneId() !== null);

  /** The stars, changing only when one is added; a snapshot with the same stars is no news. */
  readonly #stars = computed(() => this.#store.stars(), { equal: sameIds });
  /** Stars that merged just now, while you were watching: they arrive with a supernova, once. */
  readonly arriving = linkedSignal<Star[], Set<string>>({
    source: this.#stars,
    computation: (stars, previous) =>
      arrivals(previous ? new Set(previous.source.map((s) => s.id)) : null, stars, Date.now()),
  });

  readonly #keepOut = computed(() => stageKeepOut(this.width(), this.height(), this.cores()));
  readonly #pmIds = computed(() => this.anchors().map((a) => a.pmId), {
    equal: (a, b) => a.length === b.length && a.every((id, i) => id === b[i]),
  });

  /** Every PM's stars in the band. The anchors move every frame; only the PM order is read from them here. */
  readonly #placed = computed(() =>
    placeGalaxy(
      this.#stars(),
      this.#pmIds(),
      this.width(),
      this.height(),
      this.#keepOut(),
      this.#store.sprints(),
    ),
  );

  readonly skies = computed<Sky[]>(() => {
    const dark = this.#store.dark();
    const anchors = this.anchors();
    const monitor = anchors.find((a) => a.kind === 'monitor');
    // The stars lean with the sky but the cores don't, so a launch starts back by the lean.
    const lean = this.#lean();
    return this.#placed().map((p) => {
      const a = anchors.find((x) => x.pmId === p.pmId);
      const from = monitor
        ? { x: monitor.x, y: monitor.y - monitor.core - 6 }
        : { x: a?.x ?? 0, y: (a?.y ?? 0) - (a?.reach ?? 0) * ORBIT_TILT };
      const origin = { x: from.x - lean.x, y: from.y - lean.y };
      return { ...p, tint: this.#tint(p.pmId, dark), origin };
    });
  });

  /** Size, glow, and flare for every star, from how many lit up this sprint. */
  readonly look = computed(() => starLook(this.#placed().reduce((n, p) => n + p.lit.length, 0)));
  readonly litGlow = computed(() => 0.5 * (0.35 + 0.65 * this.look().presence));
  readonly fadedGlow = computed(() => 0.22 * (0.35 + 0.65 * this.look().presence));
  readonly flarePath = computed(() => {
    const f = this.look().flare;
    return f ? `M${-f},0 L${f},0 M0,${-f} L0,${f}` : null;
  });

  readonly tip = computed(() => {
    const s = this.hovered();
    if (!s) return null;
    const title = s.title.length > 30 ? `${s.title.slice(0, 29).trimEnd()}…` : s.title;
    const right = s.x + 14 + TIP_W > this.width();
    return {
      x: right ? s.x - 14 - TIP_W : s.x + 14,
      y: s.y - 20,
      tint: this.#tint(s.pmId, this.#store.dark()),
      line1: `${s.storyId} · ${title}`,
      line2: `PR #${s.pr} · merged ${new Date(s.at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`,
    };
  });

  #tint(pmId: string, dark: boolean): string {
    return starTint(this.#store.worldKindOf(pmId) ?? worldFor(pmId).kind, dark);
  }

  label(s: SkyStar): string {
    return `Story ${s.storyId}: ${s.title}${s.pr ? `, PR #${s.pr}` : ''}`;
  }

  open(s: SkyStar): void {
    if (s.prUrl) this.#store.open(s.prUrl);
  }
}
