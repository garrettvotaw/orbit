import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { OrbitStore } from './orbit-store';
import { LaneRing } from './lane-ring';
import {
  agentGlyph,
  arcPath,
  bubbleVisible,
  coreRadius,
  dotColor,
  formatAge,
  formatCost,
  liveAgents,
  occluderPath,
  ORBIT_TILT,
  statusColor,
} from './pure/layout';
import {
  boardGroups,
  isStale,
  prGroups,
  ringDots,
  ringSegments,
  type SegmentSpec,
} from './pure/ring';
import {
  AGENT_RETENTION_MS,
  BUBBLE_LINGER_MS,
  type TrackerItem,
  type Lane,
  type PrLane,
} from '../../../shared/types';
import { GLOBE_UNIT, SURFACE_LOOP, worldFor } from './pure/worlds';
import { orbMark } from './pure/guard';

type RingItem = TrackerItem | PrLane;

const RING_GAP = 12;
const RING_WIDTH = 7;
const BUBBLE_WIDTH = 200;
const BUBBLE_HEIGHT = 64;
/** A comet or a flash is worth replaying only if it just happened. */
const COMET_FRESH_MS = 10_000;

/** How far out a PM's story moons circle: past its halo and every ring of satellites. */
export function moonOrbitRadius(working: number, deepest: number): number {
  return coreRadius(working) + RING_GAP + RING_WIDTH + 4 + 10 + Math.max(0, deepest - 1) * 16 + 34;
}

@Component({
  selector: 'g[orbit-lane-core]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LaneRing],
  styles: [
    `
      .core {
        cursor: pointer;
        outline: none;
        transition: r 0.5s ease;
      }
      .globe {
        transition:
          transform 0.5s ease,
          filter 0.6s ease;
      }
      .globe.off {
        filter: saturate(0.35) brightness(0.75);
      }
      .globe.flash {
        animation: flash 1.2s ease-out;
      }
      .rim,
      .air-glow {
        transition: stroke 0.4s ease;
      }
      .pop {
        transform-box: fill-box;
        transform-origin: center;
        animation: pop 0.45s cubic-bezier(0.2, 0.8, 0.2, 1);
      }
      @keyframes pop {
        from {
          transform: scale(0);
        }
      }
      .ripple {
        fill: none;
        pointer-events: none;
        transform-box: fill-box;
        transform-origin: center;
        animation: ripple 0.9s ease-out forwards;
      }
      @keyframes ripple {
        from {
          transform: scale(1);
          opacity: 0.7;
        }
        to {
          transform: scale(2.1);
          opacity: 0;
        }
      }
      @keyframes flash {
        0% {
          filter: brightness(1.9) saturate(1.3);
        }
        100% {
          filter: brightness(1);
        }
      }
      .core:focus-visible {
        stroke: var(--text);
        stroke-width: 2;
      }
      .halo {
        transition:
          r 0.5s ease,
          opacity 0.8s ease;
      }
      .ground {
        transition: cy 0.5s ease;
      }
      .surface {
        --loop: ${SURFACE_LOOP}px;
        animation: turn 30s linear infinite;
      }
      @keyframes turn {
        to {
          transform: translateX(calc(var(--loop) * -1));
        }
      }
      .sat-shine {
        pointer-events: none;
      }
      .status-ring {
        fill: none;
        transition: stroke 0.4s ease;
      }
      .spin {
        animation: orbit 10s linear infinite;
      }
      .sweep {
        animation: orbit 4s linear infinite;
      }
      .trail {
        fill: none;
        stroke-linecap: round;
      }
      .sat {
        font: 600 7px var(--mono);
        pointer-events: none;
      }
      .comet {
        animation: comet-out 0.9s cubic-bezier(0.2, 0.7, 0.3, 1) forwards;
      }
      .comet.back {
        animation: comet-back 0.9s cubic-bezier(0.2, 0.7, 0.3, 1) forwards;
      }
      @keyframes comet-out {
        0% {
          transform: translateY(0) scale(1.4);
          opacity: 0;
        }
        20% {
          opacity: 1;
        }
        100% {
          transform: translateY(var(--to)) scale(0.6);
          opacity: 0;
        }
      }
      @keyframes comet-back {
        0% {
          transform: translateY(var(--to)) scale(0.6);
          opacity: 0;
        }
        20% {
          opacity: 1;
        }
        100% {
          transform: translateY(0) scale(1.4);
          opacity: 0;
        }
      }
      .face {
        overflow: visible;
        pointer-events: none;
      }
      .face-box {
        height: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        color: #fff;
        line-height: 1.15;
        pointer-events: none;
        text-shadow:
          0 1px 3px rgba(0, 0, 0, 0.9),
          0 0 8px rgba(0, 0, 0, 0.55);
      }
      .face-box b {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        overflow-wrap: anywhere;
        font-family: var(--display);
        font-weight: 700;
      }
      .face-box small {
        font-size: 0.78em;
        opacity: 0.85;
        margin-top: 0.2em;
        white-space: nowrap;
      }
      .bubble {
        overflow: visible;
      }
      .speech {
        box-sizing: border-box;
        height: 100%;
        display: flex;
        align-items: flex-end;
        justify-content: center;
      }
      .speech > div {
        position: relative;
        max-width: 100%;
        background: var(--surface);
        border: 1px solid var(--edge);
        border-radius: 0.6rem;
        padding: 0.3rem 0.55rem;
        color: var(--text-2);
        font-size: 0.7rem;
        line-height: 1.3;
        cursor: pointer;
        animation: bubble-rise 0.35s ease;
      }
      .speech > div > span {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .speech > div::after {
        content: '';
        position: absolute;
        left: 50%;
        bottom: -6px;
        width: 10px;
        height: 10px;
        background: var(--surface);
        border-right: 1px solid var(--edge);
        border-bottom: 1px solid var(--edge);
        transform: translateX(-50%) rotate(45deg);
      }
      .speech i {
        display: inline-block;
        width: 0.5rem;
        height: 0.5rem;
        border-radius: 50%;
        margin-right: 0.3rem;
        vertical-align: middle;
      }
      .speech b {
        color: var(--text);
        margin-right: 0.3rem;
      }
      @keyframes bubble-rise {
        from {
          opacity: 0;
          transform: translateY(10px);
        }
      }
    `,
  ],
  template: `
    <svg:circle
      class="halo"
      pointer-events="none"
      [attr.r]="haloRadius()"
      [attr.fill]="color()"
      [attr.opacity]="haloOpacity()"
      [attr.filter]="working() ? 'url(#orbit-glow)' : null"
    />
    <svg:g
      orbit-ring
      [radius]="ringRadius()"
      [width]="ringWidth"
      [segments]="segments()"
      [dots]="focused() ? ringDotList() : []"
      [stale]="stale()"
    />
    @if (lane().status === 'stopped' || lane().status === 'error') {
      <svg:circle
        class="status-ring"
        pointer-events="none"
        [attr.r]="statusRadius()"
        [attr.stroke]="color()"
        stroke-width="1.5"
        stroke-dasharray="3 7"
        opacity="0.7"
      />
    } @else {
      <svg:g [class.spin]="lane().status === 'working' || lane().status === 'starting'">
        <svg:circle
          class="status-ring"
          pointer-events="none"
          [attr.r]="statusRadius()"
          [attr.stroke]="color()"
          stroke-width="2"
          stroke-linecap="round"
          [attr.stroke-dasharray]="statusDash()"
          opacity="0.85"
          transform="rotate(-90)"
        />
      </svg:g>
    }
    @if (needsYou()) {
      <svg:g class="sweep">
        <svg:circle
          class="status-ring"
          pointer-events="none"
          [attr.r]="ringRadius()"
          stroke="#f59e0b"
          [attr.stroke-width]="ringWidth + 6"
          [attr.stroke-dasharray]="sweepDash()"
          opacity="0.28"
        />
      </svg:g>
    }
    @if (guardMark(); as mark) {
      <!-- Purple while this lane runs tests in a shared slot, dashed while it waits for one. -->
      <svg:circle
        pointer-events="none"
        [attr.r]="ringRadius() + ringWidth + 5"
        fill="none"
        [attr.stroke]="mark === 'testing' ? '#7c5cff' : 'var(--muted)'"
        stroke-width="2.5"
        [attr.stroke-dasharray]="mark === 'waiting' ? '4 6' : null"
        [attr.opacity]="mark === 'testing' ? 0.9 : 0.7"
      >
        <svg:title>
          {{ mark === 'testing' ? 'running tests' : 'waiting for a test slot' }}
        </svg:title>
      </svg:circle>
    }
    <svg:defs>
      <svg:clipPath [attr.id]="'globe-clip-' + lane().id">
        <svg:circle [attr.r]="globeUnit" />
      </svg:clipPath>
      <svg:clipPath [attr.id]="'orbit-occlude-' + lane().id">
        <svg:path [attr.d]="occluder()" clip-rule="evenodd" />
      </svg:clipPath>
      <!-- Noise worked into the land, lighter and darker by turns. -->
      <svg:filter [attr.id]="'globe-grain-' + lane().id">
        <svg:feTurbulence
          type="fractalNoise"
          baseFrequency="0.035"
          numOctaves="4"
          [attr.seed]="world().seed"
        />
        <svg:feColorMatrix
          values="0.7 0.7 0.7 0 -0.55  0.7 0.7 0.7 0 -0.55  0.7 0.7 0.7 0 -0.55  0 0 0 0 1"
        />
        <svg:feBlend in2="SourceGraphic" mode="soft-light" />
        <svg:feComposite in2="SourceGraphic" operator="in" />
      </svg:filter>
      <svg:filter
        [attr.id]="'globe-soft-' + lane().id"
        x="-20%"
        y="-50%"
        width="140%"
        height="200%"
      >
        <svg:feGaussianBlur stdDeviation="2.2" />
      </svg:filter>
      <svg:filter
        [attr.id]="'globe-haze-' + lane().id"
        x="-30%"
        y="-30%"
        width="160%"
        height="160%"
      >
        <svg:feGaussianBlur stdDeviation="5" />
      </svg:filter>
      <!-- Sunlight from the upper left: a soft highlight, and the edge darkening as it turns away. -->
      <svg:radialGradient [attr.id]="'globe-night-' + lane().id" cx="36%" cy="32%" r="78%">
        <svg:stop offset="0%" stop-color="#fff" stop-opacity="0.16" />
        <svg:stop offset="30%" stop-color="#fff" stop-opacity="0" />
        <svg:stop offset="62%" stop-color="#000" stop-opacity="0.12" />
        <svg:stop offset="100%" stop-color="#000" stop-opacity="0.6" />
      </svg:radialGradient>
      <!-- Night: everything outside the sunlit disc, with a soft terminator. -->
      <svg:filter
        [attr.id]="'globe-dusk-' + lane().id"
        x="-30%"
        y="-30%"
        width="160%"
        height="160%"
      >
        <svg:feGaussianBlur stdDeviation="9" />
      </svg:filter>
      <svg:mask [attr.id]="'globe-day-' + lane().id">
        <svg:rect x="-110" y="-110" width="220" height="220" fill="#fff" />
        <svg:circle
          cx="-38"
          cy="-34"
          r="104"
          fill="#000"
          [attr.filter]="'url(#globe-dusk-' + lane().id + ')'"
        />
      </svg:mask>
      <!-- The air thickens toward the edge, in the lane's status colour. -->
      <svg:radialGradient [attr.id]="'globe-air-' + lane().id" cx="50%" cy="50%" r="50%">
        <svg:stop offset="80%" [attr.stop-color]="color()" stop-opacity="0" />
        <svg:stop offset="94%" [attr.stop-color]="color()" stop-opacity="0.22" />
        <svg:stop offset="100%" [attr.stop-color]="color()" stop-opacity="0.55" />
      </svg:radialGradient>
    </svg:defs>
    <svg:ellipse
      class="ground"
      pointer-events="none"
      cx="0"
      [attr.cy]="radius() * 1.12"
      [attr.rx]="radius() * 0.78"
      [attr.ry]="radius() * 0.16"
      fill="#000"
      opacity="0.4"
      filter="url(#orbit-glow)"
    />
    <!-- Drawn on a sphere of globeUnit and scaled to the core, so the surface keeps its shape as it grows. -->
    <svg:g
      class="globe"
      [class.flash]="flash()"
      [class.off]="lane().status === 'stopped'"
      pointer-events="none"
      [style.transform]="'scale(' + radius() / globeUnit + ')'"
    >
      <svg:circle
        class="air-glow"
        [attr.r]="globeUnit + 2"
        fill="none"
        [attr.stroke]="color()"
        stroke-width="10"
        [attr.filter]="'url(#globe-haze-' + lane().id + ')'"
        [style.animation]="
          working() ? 'breathe ' + breathSeconds() + 's ease-in-out infinite' : 'none'
        "
      />
      <svg:g [attr.clip-path]="'url(#globe-clip-' + lane().id + ')'">
        <svg:circle [attr.r]="globeUnit" [attr.fill]="world().palette.sea" />
        <svg:g
          class="surface"
          [style.animation-duration]="spinSeconds() + 's'"
          [style.animation-play-state]="spinState()"
        >
          @for (x of loops; track x) {
            <svg:g [attr.transform]="'translate(' + x + ' 0)'">
              @for (b of world().bands; track $index) {
                <svg:path [attr.d]="b.d" [attr.fill]="b.color" />
              }
              <svg:g [attr.filter]="'url(#globe-grain-' + lane().id + ')'">
                @for (d of world().land; track $index) {
                  <svg:path
                    [attr.d]="d"
                    fill="none"
                    [attr.stroke]="world().palette.shelf"
                    stroke-width="7"
                    stroke-linejoin="round"
                    opacity="0.4"
                  />
                }
                @for (d of world().land; track $index) {
                  <svg:path [attr.d]="d" [attr.fill]="world().palette.land" />
                }
                @for (d of world().high; track $index) {
                  <svg:path [attr.d]="d" [attr.fill]="world().palette.high" opacity="0.85" />
                }
              </svg:g>
            </svg:g>
          }
        </svg:g>
        @if (world().palette.cap; as cap) {
          @for (d of world().caps; track $index) {
            <svg:path
              [attr.d]="d"
              [attr.fill]="cap"
              opacity="0.92"
              [attr.filter]="'url(#globe-soft-' + lane().id + ')'"
            />
          }
        }
        <!-- Clouds drift a little faster than the ground, each over its own faint shadow. -->
        <svg:g
          class="surface"
          [style.animation-duration]="cloudSeconds() + 's'"
          [style.animation-play-state]="spinState()"
        >
          @for (x of loops; track x) {
            <svg:g
              [attr.transform]="'translate(' + x + ' 0)'"
              [attr.filter]="'url(#globe-soft-' + lane().id + ')'"
            >
              @for (d of world().clouds; track $index) {
                <svg:path [attr.d]="d" fill="#000" opacity="0.16" transform="translate(3 4)" />
              }
              @for (d of world().clouds; track $index) {
                <svg:path [attr.d]="d" fill="#fff" opacity="0.72" />
              }
            </svg:g>
          }
        </svg:g>
        <svg:circle
          [attr.r]="globeUnit"
          fill="#02050c"
          opacity="0.62"
          [attr.mask]="'url(#globe-day-' + lane().id + ')'"
        />
        <svg:circle [attr.r]="globeUnit" [attr.fill]="'url(#globe-night-' + lane().id + ')'" />
        <svg:circle [attr.r]="globeUnit" [attr.fill]="'url(#globe-air-' + lane().id + ')'" />
      </svg:g>
      <svg:circle
        class="rim"
        [attr.r]="globeUnit"
        fill="none"
        [attr.stroke]="color()"
        stroke-width="3.2"
        opacity="0.95"
      />
    </svg:g>
    <svg:circle
      class="core"
      [attr.r]="radius()"
      fill="transparent"
      role="button"
      tabindex="0"
      [attr.aria-label]="'Open ' + lane().name"
      (click)="select()"
      (keydown.enter)="select()"
    />
    @if (ripple(); as at) {
      @for (k of [at]; track k) {
        <svg:circle class="ripple" [attr.r]="radius()" [attr.stroke]="color()" stroke-width="3" />
      }
    }
    <svg:foreignObject
      class="face"
      pointer-events="none"
      [attr.x]="-faceWidth() / 2"
      [attr.y]="-faceHeight() / 2"
      [attr.width]="faceWidth()"
      [attr.height]="faceHeight()"
    >
      <div class="face-box" xmlns="http://www.w3.org/1999/xhtml" [style.font-size.px]="nameSize()">
        <b>{{ label() }}</b>
        <small>{{ fact() }}</small>
      </div>
    </svg:foreignObject>
    <!--
      Satellites ride a tilted plane: flatten it, turn, then turn back and unflatten so each dot
      stays round and upright on an ellipse. The clip sits outside the flattening so it hides
      the far side of the real, round globe.
    -->
    <svg:g [attr.clip-path]="'url(#orbit-occlude-' + lane().id + ')'">
      <svg:g [attr.transform]="flatten">
        @for (dot of dots(); track dot.taskId) {
          <svg:g
            [style.animation]="'orbit ' + dot.period + 's linear infinite'"
            [style.animation-delay]="dot.delay + 's'"
            [style.opacity]="dot.opacity"
          >
            <svg:path
              class="trail"
              pointer-events="none"
              [attr.d]="dot.trail"
              [attr.stroke]="dot.color"
              stroke-width="3"
              opacity="0.3"
            />
            <svg:path
              class="trail"
              pointer-events="none"
              [attr.d]="dot.trailFar"
              [attr.stroke]="dot.color"
              stroke-width="2"
              opacity="0.1"
            />
            <svg:g [attr.transform]="'translate(' + dot.orbit + ' 0)'">
              <svg:g
                [style.animation]="'orbit ' + dot.period + 's linear infinite reverse'"
                [style.animation-delay]="dot.delay + 's'"
              >
                <svg:g [attr.transform]="unflatten">
                  <svg:g
                    [style.animation]="'depth ' + dot.period + 's ease-in-out infinite'"
                    [style.animation-delay]="dot.delay + 's'"
                  >
                    <svg:circle
                      class="pop"
                      cx="0"
                      cy="0"
                      r="6.5"
                      [attr.fill]="dot.color"
                      role="button"
                      tabindex="-1"
                      [attr.aria-label]="dot.title"
                      (click)="openAgent(dot.taskId, dot.title); $event.stopPropagation()"
                    >
                      <svg:title>{{ dot.title }}</svg:title>
                    </svg:circle>
                    <svg:circle class="sat-shine" r="6.5" fill="url(#orbit-sat-shade)" />
                    <svg:text
                      class="sat"
                      text-anchor="middle"
                      dominant-baseline="central"
                      fill="#0f1218"
                    >
                      {{ dot.glyph }}
                    </svg:text>
                  </svg:g>
                </svg:g>
              </svg:g>
            </svg:g>
          </svg:g>
        }
      </svg:g>
    </svg:g>
    @if (comet(); as c) {
      @for (shown of [c]; track shown.at) {
        <svg:circle
          class="comet"
          [class.back]="shown.kind === 'returned'"
          pointer-events="none"
          r="4"
          [attr.fill]="dotColor(shown.agentType)"
          [style.--to]="-(haloRadius() + 10) + 'px'"
        />
      }
    }
    <svg:text
      class="tag"
      pointer-events="none"
      text-anchor="middle"
      [attr.dy]="tagOffset()"
      fill="var(--muted)"
      font-size="0.75em"
      style="font-family: var(--mono)"
    >
      {{ tag() }}
    </svg:text>
    @if (bubble(); as b) {
      @for (shown of [b]; track shown.at) {
        <svg:foreignObject
          class="bubble"
          [attr.x]="-bubbleWidth / 2"
          [attr.y]="bubbleY()"
          [attr.width]="bubbleWidth"
          [attr.height]="bubbleHeight"
        >
          <div class="speech" xmlns="http://www.w3.org/1999/xhtml">
            <div
              role="note"
              [attr.aria-label]="lane().name + ' says'"
              [title]="shown.text"
              (click)="select()"
            >
              <span>
                @if (shown.agentType) {
                  <i [style.background]="dotColor(shown.agentType)"></i>
                  <b>{{ shown.kind === 'handoff' ? '→ ' : '← ' }}{{ shown.agentType }}</b>
                }
                {{ shown.text }}
              </span>
            </div>
          </div>
        </svg:foreignObject>
      }
    }
  `,
})
export class LaneCore {
  readonly #store = inject(OrbitStore);
  readonly lane = input.required<Lane>();
  readonly focused = input(false);
  readonly ringWidth = RING_WIDTH;
  readonly bubbleWidth = BUBBLE_WIDTH;
  readonly bubbleHeight = BUBBLE_HEIGHT;
  /** When the lane's status last changed; a ring ripples out from the core each time. */
  readonly ripple = signal(0);

  constructor() {
    let last: string | null = null;
    effect(() => {
      const status = this.lane().status;
      if (last !== null && last !== status) this.ripple.set(Date.now());
      last = status;
    });
  }

  readonly live = computed(() => liveAgents(this.lane(), this.#store.now(), AGENT_RETENTION_MS));
  /** Whether the lane holds a test slot or waits for one. */
  readonly guardMark = computed(() => orbMark(this.lane().id, this.#store.guard()));
  readonly working = computed(() => this.live().filter((a) => a.state === 'working').length);
  readonly radius = computed(() => coreRadius(this.working()));
  readonly ringRadius = computed(() => this.radius() + RING_GAP);
  readonly haloRadius = computed(() => this.ringRadius() + RING_WIDTH + 4);
  readonly statusRadius = computed(() => this.haloRadius() + 2);
  /** The globe turns briskly while working, lazily while idle, and stands still when off. */
  readonly spinSeconds = computed(() => (this.working() ? 14 : 40));
  readonly cloudSeconds = computed(() => Math.round(this.spinSeconds() * 0.7));
  readonly spinState = computed(() =>
    this.lane().status === 'stopped' || this.lane().status === 'error' ? 'paused' : 'running',
  );
  readonly globeUnit = GLOBE_UNIT;
  /** The surface is drawn twice, one loop apart, so it turns without a gap. */
  readonly loops = [0, SURFACE_LOOP];
  readonly world = computed(() =>
    worldFor(this.lane().id, this.#store.worldKindOf(this.lane().id)),
  );
  readonly flatten = `scale(1 ${ORBIT_TILT})`;
  readonly unflatten = `scale(1 ${1 / ORBIT_TILT})`;
  readonly occluder = computed(() => occluderPath(this.radius()));

  // Busier lanes glow brighter and breathe faster.
  readonly haloOpacity = computed(() => 0.12 + 0.05 * Math.min(4, this.working()));
  readonly breathSeconds = computed(() => Math.max(1.6, 3 - 0.3 * this.working()));
  /** A quarter arc that spins while working and rests while idle or asking. */
  readonly statusDash = computed(() => {
    const c = 2 * Math.PI * this.statusRadius();
    return `${c * 0.25} ${c * 0.75}`;
  });
  /** The lighthouse wedge for a lane that needs you. */
  readonly sweepDash = computed(() => {
    const c = 2 * Math.PI * this.ringRadius();
    return `${c * 0.06} ${c * 0.94}`;
  });
  /** A fresh handoff flies out from the core; a return flies back in and the core flashes. */
  readonly comet = computed(() => {
    const b = this.lane().bubble;
    if (!b || b.kind === 'said' || this.#store.now() - b.at > COMET_FRESH_MS) return null;
    return b;
  });
  readonly flash = computed(() => this.comet()?.kind === 'returned');
  readonly tagOffset = computed(() => this.haloRadius() + 26);
  readonly bubbleY = computed(() => -(this.haloRadius() + 10 + BUBBLE_HEIGHT));
  readonly bubble = computed(() => {
    const l = this.lane();
    // Shrunken lanes in the focus view have no room for a readable bubble.
    if (this.#store.selectedLaneId() && !this.focused()) return null;
    return bubbleVisible(l, this.#store.now(), BUBBLE_LINGER_MS) ? l.bubble : null;
  });
  /** The lane has stopped for your word: a question card is up, or its closing words were a question. */
  readonly waiting = computed(() => {
    const l = this.lane();
    return (
      l.status === 'idle' &&
      this.#store.attention().some((a) => a.laneId === l.id && a.kind === 'blocked')
    );
  });
  readonly needsYou = computed(() => this.lane().status === 'needs-you' || this.waiting());
  /** Product questions this PM, or any of its story moons, has open for you or the product owner. */
  readonly toDecide = computed(
    () => this.#store.decisionsAround(this.lane().id).filter((d) => d.status === 'open').length,
  );
  /** What this PM's story moons have spent between them. */
  readonly moonsCost = computed(() =>
    this.#store.moonsOf(this.lane().id).reduce((sum, m) => sum + m.costUsd + m.costInflightUsd, 0),
  );
  readonly color = computed(() => statusColor(this.needsYou() ? 'needs-you' : this.lane().status));
  /** A review core is known by its PR number; every other core wears its name. */
  readonly label = computed(() => {
    const l = this.lane();
    return l.pr ? `#${l.pr.number}` : l.name;
  });
  // Two centred lines sit across the widest part of the circle, so the box can run wider than
  // the inscribed square without touching the edge.
  readonly faceWidth = computed(() => this.radius() * 1.75);
  readonly faceHeight = computed(() => this.radius() * 1.6);
  readonly nameSize = computed(() => Math.max(11, Math.min(15, this.radius() * 0.3)));
  readonly stale = computed(() => {
    const l = this.lane();
    return (
      l.kind === 'project' &&
      isStale(l.status, l.startedAt, l.lastReport?.at ?? null, this.#store.now())
    );
  });

  readonly groups = computed<Array<SegmentSpec & { items: RingItem[] }>>(() => {
    const l = this.lane();
    if (l.kind === 'project') return boardGroups(this.#store.boardFor(l.id));
    return prGroups(this.#store.prBoardFor(l.id)?.lanes ?? []);
  });
  readonly segments = computed(() => ringSegments(this.groups(), this.ringRadius()));
  readonly ringDotList = computed(() =>
    ringDots(this.groups(), this.segments(), this.ringRadius(), (it: RingItem) =>
      'number' in it
        ? { id: `pr-${it.number}`, title: `#${it.number} ${it.title}`, url: it.url }
        : { id: it.id, title: `${it.key} ${it.title}`, url: it.url },
    ),
  );

  readonly fact = computed(() => {
    const l = this.lane();
    const n = this.working();
    if (l.status === 'needs-you') return 'asking';
    if (this.waiting()) return 'your turn';
    const asks = this.toDecide();
    if (asks && l.status === 'idle') return `${asks} to decide`;
    if (l.status === 'error') return 'error';
    if (l.status === 'stopped') return 'off';
    if (l.status === 'starting') return 'starting';
    if (n) return `${n} agent${n === 1 ? '' : 's'}`;
    if (l.kind === 'chat') return l.status === 'working' ? 'thinking' : 'chat';
    if (l.kind === 'review') return l.status === 'working' ? 'reviewing' : 'idle';
    const open = this.groups().reduce((s, g) => s + g.items.length, 0);
    return open ? `${open} open` : l.status;
  });
  readonly tag = computed(() => {
    const l = this.lane();
    const now = this.#store.now();
    // A review core shows only its PR number, so its caption still needs the name.
    const parts = l.pr ? [l.name, formatCost(l)] : [formatCost(l)];
    if (this.moonsCost() > 0) parts.push(`stories $${this.moonsCost().toFixed(2)}`);
    if (l.startedAt && l.status !== 'stopped') parts.push(formatAge(now - l.startedAt));
    if (l.kind === 'monitor' && l.nextTickAt && l.status !== 'stopped')
      parts.push(`tick in ${formatAge(l.nextTickAt - now)}`);
    return parts.join(' · ');
  });
  readonly dots = computed(() =>
    this.live().map((a, i) => {
      const orbit = this.haloRadius() + 10 + (a.depth - 1) * 16;
      return {
        taskId: a.taskId,
        color: this.dotColor(a.agentType),
        glyph: agentGlyph(a.agentType),
        orbit,
        // The satellite sits at angle 0 and turns clockwise, so its trail lags behind it counter-clockwise.
        trail: arcPath(orbit, -22, -4),
        trailFar: arcPath(orbit, -40, -22),
        period: 6 + (i % 4) * 2,
        delay: -i * 1.7,
        opacity: a.state === 'working' ? 1 : 0.3,
        title: `${a.agentType ?? 'agent'} · ${a.description}${a.summary ? ` · ${a.summary}` : ''}`,
      };
    }),
  );

  dotColor(agentType: string | null): string {
    return dotColor(agentType, this.#store.agentColors());
  }

  select(): void {
    const l = this.lane();
    if (this.focused())
      this.#store.openDrawer({ laneId: l.id, agentId: null, title: `${l.name} · PM` });
    else this.#store.select(l.id);
  }

  openAgent(taskId: string, title: string): void {
    this.#store.openDrawer({ laneId: this.lane().id, agentId: taskId, title });
  }
}
