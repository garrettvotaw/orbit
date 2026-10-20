import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** A number that rolls to its new value digit by digit instead of snapping. Non-digits sit still. */
@Component({
  selector: 'orbit-odometer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: inline-flex;
        align-items: baseline;
        font-family: var(--mono);
        font-variant-numeric: tabular-nums;
        line-height: 1;
        vertical-align: baseline;
      }
      .digit {
        display: inline-block;
        height: 1em;
        overflow: hidden;
      }
      .col {
        display: flex;
        flex-direction: column;
        transition: transform 0.6s cubic-bezier(0.2, 0.8, 0.2, 1);
      }
      .col span {
        height: 1em;
        display: block;
      }
      /* Reel digits and separators are drawn by CSS so only the hidden full value reads as text. */
      .col span::before,
      .ch::before {
        content: attr(data-d);
      }
      @media (prefers-reduced-motion: reduce) {
        .col {
          transition: none;
        }
      }
    `,
  ],
  template: `
    @for (ch of chars(); track $index) {
      @if (ch.digit !== null) {
        <span class="digit" aria-hidden="true">
          <span class="col" [style.transform]="'translateY(-' + ch.digit + 'em)'">
            @for (d of digits; track d) {
              <span [attr.data-d]="d"></span>
            }
          </span>
        </span>
      } @else {
        <span class="ch" aria-hidden="true" [attr.data-d]="ch.text"></span>
      }
    }
    <span class="visually-hidden">{{ value() }}</span>
  `,
})
export class Odometer {
  readonly value = input.required<string>();
  readonly digits = DIGITS;
  readonly chars = computed(() =>
    // A plain space collapses in generated content, so it travels as a non-breaking one.
    [...this.value()].map((text) => ({
      text: text === ' ' ? '\u00a0' : text,
      digit: /\d/.test(text) ? Number(text) : null,
    })),
  );
}
