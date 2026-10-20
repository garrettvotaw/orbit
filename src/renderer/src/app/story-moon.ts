import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { AGENT_RETENTION_MS, STORY_DONE, STORY_RESTING, type Lane } from '../../../shared/types';
import { OrbitStore } from './orbit-store';
import {
  dotColor,
  formatCost,
  liveAgents,
  MOON_RADIUS,
  ORBIT_TILT,
  statusColor,
} from './pure/layout';
import { moonFace } from './pure/worlds';
import { guardFact, orbMark } from './pure/guard';

/** How long one trip around the PM takes; slow enough to read, quick enough to notice. */
export const MOON_PERIOD_S = 90;

/** What a moon says under its number, by where the story stands. */
export function moonFact(lane: Lane): string {
  const story = lane.story;
  if (lane.status === 'needs-you') return 'asking';
  if (lane.status === 'error') return 'error';
  if (story?.stage === 'pr-opened') return story.pr ? `PR #${story.pr}` : 'PR';
  if (story?.stage === 'blocked') return 'blocked';
  if (story?.stage === 'failed') return 'failed';
  if (story?.stage === 'waiting') return 'waiting';
  if (lane.status === 'stopped') return 'off';
  const n = lane.agents.filter((a) => a.state === 'working').length;
  if (n) return `${n} agent${n === 1 ? '' : 's'}`;
  if (story?.stage === 'building') return 'building';
  if (story?.stage === 'starting' || lane.status === 'starting') return 'starting';
  return lane.status;
}

/** Whether a moon's story has finished: its PR opened, or it stopped blocked or failed. */
export function storyDone(lane: Lane): boolean {
  const stage = lane.story?.stage;
  return !!stage && STORY_DONE.includes(stage);
}

/** Whether a moon can be dismissed: its story finished, or it waits on another story's files. */
export function storyRests(lane: Lane): boolean {
  const stage = lane.story?.stage;
  return !!stage && STORY_RESTING.includes(stage);
}

/**
 * A story on a moon: a small cratered moon circling its PM's core, rimmed in the lane's status
 * colour, with the story number on its face and its own agents as specks around it. Click it
 * for the story's panel.
 */
@Component({
  selector: 'g[orbit-story-moon]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[style.--phase]': "phase() + 'deg'" },
  styles: [
    `
      :host {
        transition: --phase 1.2s ease;
      }
      /* The PM's moon clock turns the ring; each moon adds its own place on it. */
      .revolve {
        transform: rotate(calc(var(--orbit-angle) + var(--phase)));
      }
      .upright {
        transform: rotate(calc(-1 * (var(--orbit-angle) + var(--phase))));
      }
      /* Nearest at a quarter turn, furthest at three quarters, like the depth keyframes. */
      .depth {
        transform: scale(calc(0.93 + 0.17 * sin(var(--orbit-angle) + var(--phase))));
        opacity: calc(0.82 + 0.18 * sin(var(--orbit-angle) + var(--phase)));
      }
      .moon {
        cursor: pointer;
        outline: none;
      }
      .glow,
      .rim {
        transition: stroke 0.4s ease;
      }
      .moon:focus-visible {
        stroke: var(--text);
        stroke-width: 2;
      }
      .done {
        opacity: 0.55;
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
        line-height: 1.1;
        font-family: var(--display);
        text-shadow:
          0 1px 2px rgba(0, 0, 0, 0.9),
          0 0 4px rgba(0, 0, 0, 0.6);
      }
      .face-box b {
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.02em;
      }
      .face-box small {
        font-size: 7px;
        opacity: 0.85;
        white-space: nowrap;
      }
      .speck {
        animation: orbit 5s linear infinite;
      }
      .ask {
        animation: orbit 4s linear infinite;
        fill: none;
      }
    `,
  ],
  template: `
    <!-- The same tilted plane as the PM's satellites; lane-core explains how the layers fit. -->
    <svg:g [attr.clip-path]="occluder()">
      <svg:g [attr.transform]="flatten">
        <svg:g class="revolve">
          <svg:g [attr.transform]="'translate(' + orbit() + ' 0)'">
            <svg:g class="upright" [class.done]="done()">
              <svg:g [attr.transform]="unflatten">
                <svg:g class="depth">
                  @if (needsYou()) {
                    <svg:g class="ask">
                      <svg:circle
                        [attr.r]="moonRadius + 7"
                        stroke="#f59e0b"
                        stroke-width="4"
                        [attr.stroke-dasharray]="sweep()"
                        opacity="0.6"
                      />
                    </svg:g>
                  }
                  @if (mark(); as m) {
                    <!-- Purple while its tests hold a shared slot, dashed while it waits for one. -->
                    <svg:circle
                      pointer-events="none"
                      [attr.r]="moonRadius + 4"
                      fill="none"
                      [attr.stroke]="m === 'testing' ? '#7c5cff' : 'var(--muted)'"
                      stroke-width="2.5"
                      [attr.stroke-dasharray]="m === 'waiting' ? '3 4' : null"
                      [attr.opacity]="m === 'testing' ? 0.95 : 0.7"
                    />
                  }
                  @if (lane().status === 'stopped' || lane().status === 'error') {
                    <svg:circle
                      pointer-events="none"
                      [attr.r]="moonRadius + 5"
                      fill="none"
                      [attr.stroke]="color()"
                      stroke-width="1.2"
                      stroke-dasharray="2 5"
                      opacity="0.7"
                    />
                  }
                  <svg:defs>
                    <svg:clipPath [attr.id]="'moon-clip-' + lane().id">
                      <svg:circle [attr.r]="moonRadius" />
                    </svg:clipPath>
                    <!-- Fine noise worked into the rock, lighter and darker by turns. -->
                    <svg:filter [attr.id]="'moon-grain-' + lane().id">
                      <svg:feTurbulence
                        type="fractalNoise"
                        baseFrequency="0.35"
                        numOctaves="2"
                        [attr.seed]="face().seed"
                      />
                      <svg:feColorMatrix
                        values="0.5 0.5 0.5 0 -0.25  0.5 0.5 0.5 0 -0.25  0.5 0.5 0.5 0 -0.25  0 0 0 0 1"
                      />
                      <svg:feBlend in2="SourceGraphic" mode="soft-light" />
                      <svg:feComposite in2="SourceGraphic" operator="in" />
                    </svg:filter>
                    <svg:filter
                      [attr.id]="'moon-haze-' + lane().id"
                      x="-50%"
                      y="-50%"
                      width="200%"
                      height="200%"
                    >
                      <svg:feGaussianBlur stdDeviation="2.2" />
                    </svg:filter>
                    <!-- Sunlight from the upper left: a soft highlight, and the edge darkening as it turns away. -->
                    <svg:radialGradient
                      [attr.id]="'moon-night-' + lane().id"
                      cx="36%"
                      cy="32%"
                      r="78%"
                    >
                      <svg:stop offset="0%" stop-color="#fff" stop-opacity="0.22" />
                      <svg:stop offset="30%" stop-color="#fff" stop-opacity="0" />
                      <svg:stop offset="62%" stop-color="#000" stop-opacity="0.12" />
                      <svg:stop offset="100%" stop-color="#000" stop-opacity="0.55" />
                    </svg:radialGradient>
                    <!-- Night: everything outside the sunlit disc, with a soft terminator. -->
                    <svg:filter
                      [attr.id]="'moon-dusk-' + lane().id"
                      x="-30%"
                      y="-30%"
                      width="160%"
                      height="160%"
                    >
                      <svg:feGaussianBlur stdDeviation="2" />
                    </svg:filter>
                    <svg:mask [attr.id]="'moon-day-' + lane().id">
                      <svg:rect x="-22" y="-22" width="44" height="44" fill="#fff" />
                      <svg:circle
                        cx="-7.6"
                        cy="-6.8"
                        r="20.8"
                        fill="#000"
                        [attr.filter]="'url(#moon-dusk-' + lane().id + ')'"
                      />
                    </svg:mask>
                    <!-- A crater's far wall catches the light; its near wall sits in shadow. -->
                    <svg:linearGradient
                      [attr.id]="'moon-crater-' + lane().id"
                      x1="0.15"
                      y1="0.15"
                      x2="0.85"
                      y2="0.85"
                    >
                      <svg:stop offset="0%" [attr.stop-color]="face().dark" stop-opacity="0.9" />
                      <svg:stop offset="55%" [attr.stop-color]="face().dark" stop-opacity="0.35" />
                      <svg:stop offset="100%" [attr.stop-color]="face().light" stop-opacity="0.7" />
                    </svg:linearGradient>
                  </svg:defs>
                  <svg:circle
                    class="glow"
                    pointer-events="none"
                    [attr.r]="moonRadius + 1.5"
                    fill="none"
                    [attr.stroke]="color()"
                    stroke-width="3.5"
                    [attr.filter]="'url(#moon-haze-' + lane().id + ')'"
                  />
                  <svg:g
                    pointer-events="none"
                    [attr.clip-path]="'url(#moon-clip-' + lane().id + ')'"
                  >
                    <svg:g [attr.filter]="'url(#moon-grain-' + lane().id + ')'">
                      <svg:circle [attr.r]="moonRadius" [attr.fill]="face().base" />
                      @for (d of face().maria; track $index) {
                        <svg:path [attr.d]="d" [attr.fill]="face().dark" opacity="0.4" />
                      }
                      @for (c of face().craters; track $index) {
                        <svg:circle
                          [attr.cx]="c.x"
                          [attr.cy]="c.y"
                          [attr.r]="c.r"
                          [attr.fill]="'url(#moon-crater-' + lane().id + ')'"
                          [attr.stroke]="face().light"
                          stroke-width="0.6"
                          stroke-opacity="0.6"
                        />
                      }
                    </svg:g>
                    <svg:circle
                      [attr.r]="moonRadius"
                      fill="#02050c"
                      opacity="0.6"
                      [attr.mask]="'url(#moon-day-' + lane().id + ')'"
                    />
                    <svg:circle
                      [attr.r]="moonRadius"
                      [attr.fill]="'url(#moon-night-' + lane().id + ')'"
                    />
                  </svg:g>
                  <svg:circle
                    class="rim"
                    pointer-events="none"
                    [attr.r]="moonRadius"
                    fill="none"
                    [attr.stroke]="color()"
                    stroke-width="1.6"
                  />
                  <svg:circle
                    class="moon"
                    [attr.r]="moonRadius"
                    fill="transparent"
                    role="button"
                    tabindex="0"
                    [attr.aria-label]="'Open story ' + lane().story?.storyId"
                    (click)="select(); $event.stopPropagation()"
                    (keydown.enter)="select()"
                  >
                    <svg:title>{{ lane().name }} · {{ fact() }}</svg:title>
                  </svg:circle>
                  <svg:foreignObject
                    class="face"
                    [attr.x]="-moonRadius"
                    [attr.y]="-moonRadius"
                    [attr.width]="moonRadius * 2"
                    [attr.height]="moonRadius * 2"
                  >
                    <div class="face-box" xmlns="http://www.w3.org/1999/xhtml">
                      <b>{{ lane().story?.storyId }}</b>
                      <small>{{ fact() }}</small>
                    </div>
                  </svg:foreignObject>
                  @for (s of specks(); track s.taskId) {
                    <svg:g
                      class="speck"
                      [style.animation-delay]="s.delay + 's'"
                      [style.opacity]="s.opacity"
                    >
                      <svg:circle [attr.cx]="moonRadius + 8" cy="0" r="3" [attr.fill]="s.color">
                        <svg:title>{{ s.title }}</svg:title>
                      </svg:circle>
                    </svg:g>
                  }
                </svg:g>
              </svg:g>
            </svg:g>
          </svg:g>
        </svg:g>
      </svg:g>
    </svg:g>
  `,
})
export class StoryMoon {
  readonly #store = inject(OrbitStore);
  readonly lane = input.required<Lane>();
  /** Which of its PM's moons this is, and how many there are, so they share the ring evenly. */
  readonly index = input(0);
  readonly count = input(1);
  /** Distance from the PM's centre. */
  readonly orbit = input(120);
  readonly moonRadius = MOON_RADIUS;
  readonly flatten = `scale(1 ${ORBIT_TILT})`;
  readonly unflatten = `scale(1 ${1 / ORBIT_TILT})`;
  /** The PM's globe hides the moon on the far side of its orbit. */
  readonly occluder = computed(() => {
    const pm = this.lane().parentId;
    return pm ? `url(#orbit-occlude-${pm})` : null;
  });

  /** Where on the ring this moon sits, so the PM's moons share it evenly. */
  readonly phase = computed(() => (360 * this.index()) / Math.max(1, this.count()));
  readonly face = computed(() => moonFace(this.lane().id, MOON_RADIUS));
  readonly live = computed(() => liveAgents(this.lane(), this.#store.now(), AGENT_RETENTION_MS));
  readonly needsYou = computed(() => this.lane().status === 'needs-you');
  readonly done = computed(() => storyDone(this.lane()));
  readonly color = computed(() => statusColor(this.lane().status));
  readonly mark = computed(() => orbMark(this.lane().id, this.#store.guard()));
  /** Asking and error outrank the test line; the line outranks the rest. */
  readonly fact = computed(() => {
    const lane = this.lane();
    const inLine = guardFact(lane.id, this.#store.guard());
    return inLine && lane.status !== 'needs-you' && lane.status !== 'error'
      ? inLine
      : moonFact(lane);
  });
  readonly sweep = computed(() => {
    const c = 2 * Math.PI * (this.moonRadius + 7);
    return `${c * 0.12} ${c * 0.88}`;
  });
  readonly specks = computed(() =>
    this.live().map((a, i) => ({
      taskId: a.taskId,
      color: dotColor(a.agentType, this.#store.agentColors()),
      delay: -i * 1.3,
      opacity: a.state === 'working' ? 1 : 0.3,
      title: `${a.agentType ?? 'agent'} · ${a.description}`,
    })),
  );

  cost(): string {
    return formatCost(this.lane());
  }

  select(): void {
    this.#store.select(this.lane().id);
  }
}
