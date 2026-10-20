import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { OrbitStore } from './orbit-store';
import { LaneCore, moonOrbitRadius } from './lane-core';
import { MOON_PERIOD_S, StoryMoon } from './story-moon';
import type { Lane } from '../../../shared/types';
import { AttentionRail } from './attention-rail';
import { LanePanel } from './lane-panel';
import { BoardColumns } from './board-columns';
import { AgentDrawer } from './agent-drawer';
import { NewOrbitDialog } from './new-orbit-dialog';
import { ReviewsPanel } from './reviews-panel';
import { DecisionsPanel } from './decisions-panel';
import { Starfield } from './starfield';
import { GalaxyBand } from './galaxy-band';
import { Constellations, type RestingCore, type SkyAnchor } from './constellations';
import { GuardPanel } from './guard-panel';
import { prSummary, stageLayout } from './pure/ring';
import {
  agentGlyph,
  agentLegend,
  coreRadius,
  laneMass,
  MOON_REACH,
  spreadOrbit,
  stageTint,
} from './pure/layout';
import { restingPlaces, Stage, type Field, type GravityField } from './pure/physics';

@Component({
  selector: 'orbit-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(pointermove)': 'onPointer($event)' },
  imports: [
    LaneCore,
    StoryMoon,
    AttentionRail,
    LanePanel,
    BoardColumns,
    AgentDrawer,
    NewOrbitDialog,
    ReviewsPanel,
    DecisionsPanel,
    Starfield,
    GalaxyBand,
    Constellations,
    GuardPanel,
  ],
  styles: [
    `
      :host {
        display: block;
        position: relative;
        flex: 1 1 auto;
        min-height: 0;
        overflow: hidden;
      }
      svg.stage {
        position: relative;
        width: 100%;
        height: 100%;
        display: block;
      }
      /* Position comes from the physics loop every frame; only the zoom eases on its own. */
      .zoom {
        transition: transform 0.55s cubic-bezier(0.2, 0.8, 0.2, 1);
      }
      /* One clock turns all of a PM's moons so they stay evenly spaced; pointing at one holds them all. */
      .moons {
        animation: moon-clock ${MOON_PERIOD_S}s linear infinite;
      }
      .moons:hover,
      .moons:focus-within {
        animation-play-state: paused;
      }
      .sunrise {
        position: absolute;
        inset: 0;
        pointer-events: none;
        background: radial-gradient(
          ellipse at 50% 110%,
          rgba(245, 158, 11, 0.55),
          rgba(245, 158, 11, 0) 60%
        );
        animation: sunrise 1.6s ease-out forwards;
      }
      @keyframes sunrise {
        0% {
          opacity: 0;
          transform: translateY(20%);
        }
        30% {
          opacity: 1;
        }
        100% {
          opacity: 0;
          transform: translateY(-10%);
        }
      }
      .sunset {
        position: absolute;
        inset: 0;
        pointer-events: none;
        background: linear-gradient(
          to bottom,
          rgba(124, 92, 255, 0) 0%,
          rgba(124, 92, 255, 0.28) 45%,
          rgba(245, 158, 11, 0.35) 100%
        );
        animation: sunset 2.4s ease-in-out forwards;
      }
      @keyframes sunset {
        0% {
          opacity: 0;
          transform: translateY(-30%);
        }
        35% {
          opacity: 1;
        }
        100% {
          opacity: 0;
          transform: translateY(25%);
        }
      }
      .top-right {
        position: absolute;
        top: 1rem;
        right: 1rem;
        display: flex;
        gap: 0.5rem;
      }
      .top-right .lit {
        border-color: #a78bfa;
        color: var(--text);
      }
      /* The memory panel stacks on the legend in the bottom-right corner. */
      .corner {
        position: absolute;
        right: 1rem;
        bottom: 1rem;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 0.5rem;
      }
      .legend {
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
      .legend i {
        display: inline-block;
        width: 0.5rem;
        height: 0.5rem;
        border-radius: 50%;
        margin: 0 0.3rem 0 0.6rem;
        vertical-align: middle;
      }
      .legend i.glyph {
        width: auto;
        min-width: 1.1rem;
        height: auto;
        padding: 0 0.2rem;
        border-radius: 0.25rem;
        border: 1px solid;
        font: 600 0.62rem/1.3 var(--mono);
        font-style: normal;
        text-align: center;
      }
      .report {
        position: absolute;
        left: 1rem;
        right: calc(min(26rem, 38vw) + 2rem);
        bottom: 1rem;
        color: var(--muted);
        font-size: 0.8rem;
        background: var(--panel-bg);
        backdrop-filter: blur(14px) saturate(1.2);
        box-shadow: var(--panel-shadow);
        isolation: isolate;
        border: 1px solid var(--edge);
        border-radius: 0.5rem;
        padding: 0.45rem 0.75rem;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .report b {
        color: var(--text);
      }
      .report .blocked {
        color: #f59e0b;
      }
      .report .board-link {
        background: transparent;
        border: 0;
        padding: 0;
        color: var(--link);
        text-decoration: underline;
        font-size: inherit;
        margin-left: 0.4rem;
      }
    `,
  ],
  template: `
    <orbit-galaxy-band
      [width]="size().w"
      [height]="size().h"
      [dim]="store.selectedLaneId() !== null"
      [tilt]="tilt()"
    />
    <orbit-starfield [width]="size().w" [height]="size().h" [tilt]="tilt()" />
    @for (flash of sunrise(); track flash) {
      <div class="sunrise" aria-hidden="true"></div>
    }
    @for (dusk of sunset(); track dusk) {
      <div class="sunset" aria-hidden="true"></div>
    }
    <svg
      #stage
      class="stage"
      [attr.viewBox]="'0 0 ' + size().w + ' ' + size().h"
      preserveAspectRatio="none"
      role="img"
      aria-label="Orbit of lanes"
    >
      <defs>
        <filter id="orbit-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="7" />
        </filter>
        <radialGradient id="orbit-sat-shade" cx="35%" cy="30%" r="65%">
          <stop offset="0%" stop-color="#fff" stop-opacity="0.45" />
          <stop offset="45%" stop-color="#fff" stop-opacity="0" />
          <stop offset="100%" stop-color="#000" stop-opacity="0.45" />
        </radialGradient>
        <radialGradient id="galaxy-clearing">
          <stop offset="0%" style="stop-color: var(--stage-bg)" stop-opacity="0.92" />
          <stop offset="100%" style="stop-color: var(--stage-bg)" stop-opacity="0" />
        </radialGradient>
      </defs>
      <!-- Each core sits in a clearing so the galaxy never fights its label; the PR stars go on top. -->
      @if (store.dark()) {
        <g class="clearings" aria-hidden="true">
          @for (c of clearings(); track c.id) {
            <circle [attr.cx]="c.x" [attr.cy]="c.y" [attr.r]="c.r" fill="url(#galaxy-clearing)" />
          }
        </g>
      }
      <g
        orbit-constellations
        [anchors]="skyAnchors()"
        [cores]="restingCores()"
        [width]="size().w"
        [height]="size().h"
        [tilt]="tilt()"
      />
      @for (lane of store.homeLanes(); track lane.id; let i = $index) {
        <g class="lane" [style.transform]="moveFor(lane.id)">
          <g class="zoom" [style.transform]="zoomFor(i)">
            <g orbit-lane-core [lane]="lane" [focused]="store.focusLaneId() === lane.id" />
            <g class="moons">
              @for (moon of store.moonsOf(lane.id); track moon.id; let m = $index) {
                <g
                  orbit-story-moon
                  [lane]="moon"
                  [index]="m"
                  [count]="store.moonsOf(lane.id).length"
                  [orbit]="moonOrbit(lane)"
                />
              }
            </g>
          </g>
        </g>
      }
    </svg>
    <orbit-attention-rail />
    @if (store.selectedLane(); as lane) {
      <orbit-lane-panel />
      @if (store.boardOpen()) {
        <orbit-board-columns />
      }
      @if (
        !store.drawer() &&
        !store.reviewsOpen() &&
        lane.kind !== 'chat' &&
        lane.kind !== 'review' &&
        lane.kind !== 'story'
      ) {
        <div class="report" aria-label="Last board report">
          @if (lane.lastReport; as r) {
            <b>Last board</b> · Shipped {{ r.shipped.length }} · In flight {{ r.inFlight.length }} ·
            Drift {{ r.drift.length }} · <span class="blocked">Blocked {{ r.blocked.length }}</span>
            @if (r.next) {
              · Next: {{ r.next }}
            }
          } @else if (lane.kind === 'monitor') {
            <b>PR monitor</b> · {{ prSummary() }}
          } @else {
            <b>No board report yet</b> · the PM posts one when its run finishes
          }
          @if (!store.boardOpen()) {
            <button class="board-link" type="button" (click)="store.boardOpen.set(true)">
              Show board
            </button>
          }
        </div>
      }
    }
    <orbit-agent-drawer />
    <orbit-reviews-panel />
    <orbit-decisions-panel />
    <div class="top-right">
      <button
        type="button"
        [attr.aria-pressed]="store.decisionsOpen()"
        [class.lit]="store.openDecisions().length > 0"
        (click)="toggleDecisions()"
        title="Product questions the PMs need answered"
      >
        Decisions{{ store.openDecisions().length ? ' · ' + store.openDecisions().length : '' }}
      </button>
      <button
        type="button"
        [attr.aria-pressed]="store.reviewsOpen()"
        (click)="toggleReviews()"
        title="Team pull requests waiting for review"
      >
        Reviews{{ askedCount() ? ' · ' + askedCount() : '' }}
      </button>
      <button
        type="button"
        (click)="store.newOrbitOpen.set(true)"
        title="Add a project PM or a chat"
      >
        ＋ New orbit
      </button>
      <button
        type="button"
        (click)="morning()"
        [disabled]="store.allLive()"
        [title]="
          store.allLive()
            ? 'Everything is already running'
            : 'Start every lane in your morning list'
        "
      >
        ▶ Morning start
      </button>
      <button
        type="button"
        (click)="evening()"
        [disabled]="!store.anyLive()"
        [title]="
          store.anyLive()
            ? 'Wind every lane down gently; each one can be resumed tomorrow'
            : 'Nothing is running'
        "
      >
        ◐ End the day
      </button>
    </div>
    <orbit-new-orbit-dialog />
    @if (!store.selectedLane()) {
      <div class="corner">
        @if (store.guard().totalBytes > 0) {
          <orbit-guard-panel />
        }
        <div class="legend" aria-label="Legend">
          <i style="background:#2fb344"></i>working <i style="background:#3b82f6"></i>idle
          <i style="background:#f59e0b"></i>needs you <i style="background:#ef4444"></i>error
          <i style="background:var(--dim)"></i>off
          <br />
          <i style="background:#64748b"></i>new <i style="background:#2fb344"></i>active
          <i style="background:#a78bfa"></i>pull request <i style="background:#f59e0b"></i>dev test
          <i style="background:#3b82f6"></i>PO review
          @if (legendAgents().length) {
            <br />
            @for (a of legendAgents(); track a.name) {
              <i class="glyph" [style.color]="a.color" [style.border-color]="a.color">{{
                glyph(a.name)
              }}</i
              >{{ a.name }}
            }
          }
        </div>
      </div>
    }
  `,
})
export class OrbitHome {
  readonly store = inject(OrbitStore);
  readonly #destroyRef = inject(DestroyRef);
  private readonly stage = viewChild.required<ElementRef<SVGSVGElement>>('stage');
  readonly size = signal({ w: 1200, h: 800 });
  /** Pointer position as -1..1 from the middle of the stage, for the sky's parallax. */
  readonly tilt = signal({ x: 0, y: 0 });
  /** One entry per Morning start, so each click replays the sunrise. */
  readonly sunrise = signal<number[]>([]);
  /** One entry per End the day, so each click replays the sunset. */
  readonly sunset = signal<number[]>([]);
  readonly legendAgents = computed(() => agentLegend(this.store.lanes(), this.store.agentColors()));
  // Lanes keep their config order on the home row; work never reshuffles them.
  readonly layout = computed(() =>
    stageLayout(
      this.store.homeLanes().length,
      this.store.selectedIndex(),
      this.store.boardOpen(),
      this.size().w,
      this.size().h,
      undefined,
      this.store.homeLanes().map((lane) => this.reachOf(lane)),
    ),
  );
  readonly askedCount = computed(
    () => this.store.teamPrs().prs.filter((p) => p.requested === 'you').length,
  );
  readonly prSummary = computed(() => {
    const lane = this.store.selectedLane();
    const b = lane ? this.store.prBoardFor(lane.id) : null;
    return b ? prSummary(b.lanes) : 'no state yet';
  });

  /** A PM's weight counts the stories on its moons: their agents are its work too. */
  massOf(lane: Lane): number {
    return laneMass(lane) + this.store.moonsOf(lane.id).reduce((sum, m) => sum + laneMass(m), 0);
  }

  /** How far out a PM's moons circle: beyond its halo and its deepest ring of satellites, and wide enough that none touch. */
  moonOrbit(lane: Lane): number {
    const working = lane.agents.filter((a) => a.state === 'working').length;
    const deepest = lane.agents.reduce((d, a) => Math.max(d, a.depth), 1);
    return spreadOrbit(moonOrbitRadius(working, deepest), this.store.moonsOf(lane.id).length);
  }

  /** How far a lane reaches from its centre: its moons' ring when it has any, else its core and rings. */
  reachOf(lane: Lane): number {
    if (this.store.moonsOf(lane.id).length) return this.moonOrbit(lane) + MOON_REACH + 1;
    return coreRadius(lane.agents.filter((a) => a.state === 'working').length) + 40;
  }

  /** The soft dark patch under each core, following it and its zoom, so the galaxy never crowds a label. */
  readonly clearings = computed(() => {
    const bodies = this.bodies();
    const layout = this.layout();
    return this.store.homeLanes().flatMap((lane, i) => {
      const b = bodies.get(lane.id);
      const core = coreRadius(lane.agents.filter((a) => a.state === 'working').length);
      return b
        ? [{ id: lane.id, x: b.x, y: b.y, r: (core + 22) * 1.9 * (layout[i]?.scale ?? 1) }]
        : [];
    });
  });

  /**
   * Where the home row's cores come to rest, so PR stars keep off them. It is worked out from the
   * row's layout rather than read off the physics, so stars never dodge a planet gliding past and
   * don't wait for the row to settle.
   */
  readonly restingCores = computed<RestingCore[]>(() => {
    const lanes = this.store.homeLanes();
    const row = this.homeField();
    const xs = restingPlaces(
      lanes.map((lane) => ({
        id: lane.id,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        mass: 1,
        radius: this.reachOf(lane),
      })),
      row,
    );
    return lanes.map((lane, i) => ({
      x: xs[i],
      y: row.cy,
      r: coreRadius(lane.agents.filter((a) => a.state === 'working').length),
    }));
  });

  /** Where each home lane is right now, for keeping its tint and the launches from the PR monitor. */
  readonly skyAnchors = computed<SkyAnchor[]>(() => {
    const bodies = this.bodies();
    return this.store.homeLanes().flatMap((lane) => {
      const b = bodies.get(lane.id);
      const core = coreRadius(lane.agents.filter((a) => a.state === 'working').length);
      return b
        ? [{ pmId: lane.id, kind: lane.kind, x: b.x, y: b.y, core, reach: this.reachOf(lane) }]
        : [];
    });
  });

  /** Where the physics has this lane right now. */
  moveFor(laneId: string): string {
    const b = this.bodies().get(laneId);
    return b ? `translate(${b.x.toFixed(1)}px, ${b.y.toFixed(1)}px)` : '';
  }

  zoomFor(i: number): string {
    return `scale(${this.layout()[i]?.scale ?? 1})`;
  }

  /** Where the physics has each lane right now; a fresh snapshot every frame. */
  readonly bodies = signal(new Map<string, { x: number; y: number }>());
  readonly #reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  #stage: Stage | null = null;
  #frame: number | null = null;
  #lastTick = 0;

  /** The home row's gravity: lanes in config order, centred, shoulder to shoulder. */
  readonly homeField = computed<GravityField>(() => {
    const { w, h } = this.size();
    return {
      kind: 'gravity',
      cx: w / 2,
      cy: Math.round(h * 0.55),
      minX: 24,
      maxX: w - 24,
      gap: 36,
    };
  });

  /** The field the bodies live in: gravity on the home row, anchors in the focus view. */
  readonly field = computed<Field>(() =>
    this.store.selectedIndex() === null
      ? this.homeField()
      : { kind: 'anchors', targets: this.layout().map((p) => ({ x: p.x, y: p.y })) },
  );

  /** Reconcile the simulation with the lanes and the field, then run it until everything rests. */
  #syncBodies(): void {
    const lanes = this.store.homeLanes();
    const layout = this.layout();
    const field = this.field();
    const was = new Map((this.#stage?.bodies() ?? []).map((b) => [b.id, b]));
    let changed = was.size !== lanes.length;
    const bodies = lanes.map((lane, i) => {
      const mass = 1 + this.massOf(lane);
      const radius = this.reachOf(lane);
      const b = was.get(lane.id);
      if (b) {
        if (b.mass !== mass || b.radius !== radius) changed = true;
        b.mass = mass;
        b.radius = radius;
        return b;
      }
      // A new lane rises in from below its slot.
      changed = true;
      const seed = layout[i] ?? { x: this.size().w / 2, y: this.size().h };
      return { id: lane.id, x: seed.x, y: seed.y + 120, vx: 0, vy: 0, mass, radius };
    });
    if (!this.#stage) this.#stage = new Stage(bodies, field);
    else {
      if (changed) this.#stage.setBodies(bodies);
      if (JSON.stringify(this.#stage.field()) !== JSON.stringify(field))
        this.#stage.setField(field);
    }
    if (this.#reduceMotion.matches || document.hidden) {
      this.#settleNow();
      return;
    }
    this.#wake();
  }

  #publish(): void {
    const stage = this.#stage;
    if (!stage) return;
    this.bodies.set(new Map(stage.bodies().map((b) => [b.id, { x: b.x, y: b.y }])));
  }

  /** Jump straight to where the bodies would come to rest and stop the loop. */
  #settleNow(): void {
    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.#frame = null;
    this.#stage?.settle();
    this.#publish();
  }

  #wake(): void {
    this.#publish();
    if (this.#frame !== null) return;
    this.#lastTick = performance.now();
    const tick = (now: number) => {
      this.#frame = null;
      // A long frame gets more than one step so motion keeps the same pace.
      const frames = Math.min(3, Math.max(1, Math.round((now - this.#lastTick) / 16.7)));
      this.#lastTick = now;
      const more = this.#stage?.step(frames) ?? false;
      this.#publish();
      if (more) this.#frame = requestAnimationFrame(tick);
    };
    this.#frame = requestAnimationFrame(tick);
  }
  toggleDecisions(): void {
    const next = !this.store.decisionsOpen();
    this.store.decisionsOpen.set(next);
    if (next) this.store.reviewsOpen.set(false);
  }

  toggleReviews(): void {
    const next = !this.store.reviewsOpen();
    this.store.reviewsOpen.set(next);
    if (next) this.store.decisionsOpen.set(false);
  }

  onPointer(e: PointerEvent): void {
    const host = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.tilt.set({
      x: ((e.clientX - host.left) / host.width) * 2 - 1,
      y: ((e.clientY - host.top) / host.height) * 2 - 1,
    });
  }

  glyph(agentType: string): string {
    return agentGlyph(agentType);
  }

  morning(): void {
    void this.store.command({ type: 'morning' });
    this.sunrise.update((list) => [...list.slice(-2), Date.now()]);
  }

  evening(): void {
    void this.store.command({ type: 'evening' });
    this.sunset.update((list) => [...list.slice(-2), Date.now()]);
  }

  constructor() {
    let observer: ResizeObserver | null = null;
    afterRenderEffect(() => {
      if (observer) return;
      observer = new ResizeObserver(([e]) =>
        this.size.set({
          w: Math.max(600, e.contentRect.width),
          h: Math.max(400, e.contentRect.height),
        }),
      );
      observer.observe(this.stage().nativeElement);
    });
    this.#destroyRef.onDestroy(() => observer?.disconnect());
    // The stage's tint follows the clock; the store ticks every few seconds, the hour rarely changes.
    effect(() => {
      const hour = new Date(this.store.now()).getHours();
      document.documentElement.style.setProperty('--stage-bg', stageTint(hour, this.store.dark()));
    });
    // Anything that changes a lane's weight, the field, or the stage wakes the physics.
    effect(() => {
      this.store.lanes();
      this.field();
      untracked(() => this.#syncBodies());
    });
    // Frames stop while the window is hidden, so land everything now rather than mid-glide later.
    const onHidden = () => {
      if (document.hidden && this.#frame !== null) this.#settleNow();
    };
    document.addEventListener('visibilitychange', onHidden);
    this.#destroyRef.onDestroy(() => document.removeEventListener('visibilitychange', onHidden));
    this.#destroyRef.onDestroy(() => {
      if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    });
  }
}
