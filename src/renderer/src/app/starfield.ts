import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { leanFor, starfield, type SkyDepth } from './pure/stars';

/** The sky behind the stage: two layers of stars that lean away from the pointer, the near one a little more. */
@Component({
  selector: 'orbit-starfield',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true' },
  styles: [
    `
      :host {
        position: absolute;
        inset: 0;
        pointer-events: none;
        overflow: hidden;
      }
      svg {
        width: 100%;
        height: 100%;
        display: block;
        opacity: var(--star-strength);
        transform: scale(1.03);
      }
      .far,
      .near {
        transition: transform 0.9s cubic-bezier(0.2, 0.8, 0.2, 1);
      }
      .glow {
        animation: twinkle 6s ease-in-out infinite;
      }
      @keyframes twinkle {
        0%,
        100% {
          opacity: 0.5;
        }
        50% {
          opacity: 1;
        }
      }
    `,
  ],
  template: `
    <svg [attr.viewBox]="'0 0 ' + width() + ' ' + height()" preserveAspectRatio="xMidYMid slice">
      <g class="far" [style.transform]="lean('far')">
        @for (s of far(); track $index) {
          <circle
            [attr.cx]="s.x"
            [attr.cy]="s.y"
            [attr.r]="s.r"
            fill="var(--star)"
            [attr.opacity]="s.opacity"
          />
        }
      </g>
      <g class="near" [style.transform]="lean('near')">
        @for (s of near(); track $index) {
          <circle
            [class.glow]="s.opacity === 1"
            [attr.cx]="s.x"
            [attr.cy]="s.y"
            [attr.r]="s.r"
            fill="var(--star-bright)"
            [attr.opacity]="s.opacity"
          />
        }
      </g>
    </svg>
  `,
})
export class Starfield {
  readonly width = input(1200);
  readonly height = input(800);
  /** Where the pointer is, -1..1 from the middle; the sky leans a little the other way. */
  readonly tilt = input({ x: 0, y: 0 });
  // Stars are laid out on a slightly larger sheet so leaning never shows an edge.
  readonly stars = computed(() => starfield(this.width() * 1.1, this.height() * 1.1));
  readonly far = computed(() => this.stars().filter((s) => s.layer === 0));
  readonly near = computed(() => this.stars().filter((s) => s.layer === 1));

  lean(depth: SkyDepth): string {
    const { x, y } = leanFor(this.tilt(), depth);
    return `translate(${x}px, ${y}px)`;
  }
}
