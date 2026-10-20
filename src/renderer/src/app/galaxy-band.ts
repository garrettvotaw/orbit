import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { OrbitStore } from './orbit-store';
import { bandDust, type Dust } from './pure/galaxy';
import { leanFor } from './pure/stars';

/** How far the canvas runs past the stage on every side, so leaning never shows its edge. */
const MARGIN = 24;

/**
 * The Milky Way behind the stage: a band of glow and dust from corner to corner, painted onto a
 * canvas once per stage size, since it is far too many specks to draw as SVG. It leans with the
 * far stars, so the sky moves as one. Dark theme only; it dims in the focus view so the sky never
 * goes blank.
 */
@Component({
  selector: 'orbit-galaxy-band',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true', '[class.dim]': 'dim()', '[style.transform]': 'lean()' },
  styles: [
    `
      :host {
        position: absolute;
        inset: -${MARGIN}px;
        pointer-events: none;
        transition:
          opacity 0.6s ease,
          transform 0.9s cubic-bezier(0.2, 0.8, 0.2, 1);
      }
      :host(.dim) {
        opacity: 0.5;
      }
      canvas {
        width: 100%;
        height: 100%;
        display: block;
      }
    `,
  ],
  template: `<canvas #sky></canvas>`,
})
export class GalaxyBand {
  readonly #store = inject(OrbitStore);
  readonly width = input(1200);
  readonly height = input(800);
  readonly dim = input(false);
  /** Where the pointer is, -1..1 from the middle; the band leans the other way with the far stars. */
  readonly tilt = input({ x: 0, y: 0 });
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('sky');
  readonly #dust = computed(() => bandDust(this.width(), this.height()));
  readonly lean = computed(() => {
    const { x, y } = leanFor(this.tilt(), 'far');
    return `translate(${x}px, ${y}px)`;
  });

  constructor() {
    afterRenderEffect(() =>
      paint(
        this.canvas().nativeElement,
        this.width(),
        this.height(),
        this.#store.dark() ? this.#dust() : null,
      ),
    );
  }
}

function radial(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  inner: string,
  outer: string,
): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Glow and specks add up like light; the dark wisps then cut the band back to the stage beneath.
 * The canvas runs `MARGIN` past the stage on every side, so the band is drawn shifted into it.
 */
function paint(canvas: HTMLCanvasElement, w: number, h: number, dust: Dust | null): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round((w + 2 * MARGIN) * dpr);
  canvas.height = Math.round((h + 2 * MARGIN) * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, MARGIN * dpr, MARGIN * dpr);
  ctx.clearRect(-MARGIN, -MARGIN, w + 2 * MARGIN, h + 2 * MARGIN);
  if (!dust) return;
  ctx.globalCompositeOperation = 'lighter';
  for (const g of dust.glows)
    radial(ctx, g.x, g.y, g.r, `rgba(${g.rgb},${g.a})`, `rgba(${g.rgb},0)`);
  for (const s of dust.specks) {
    ctx.fillStyle = `rgba(228,232,242,${s.a})`;
    ctx.fillRect(s.x, s.y, s.size, s.size);
  }
  ctx.globalCompositeOperation = 'destination-out';
  for (const d of dust.wisps) radial(ctx, d.x, d.y, d.r, `rgba(0,0,0,${d.a})`, 'rgba(0,0,0,0)');
  ctx.globalCompositeOperation = 'source-over';
}
