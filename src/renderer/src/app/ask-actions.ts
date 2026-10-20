import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { Ask } from '../../../shared/ask';

/**
 * One-click answers to a lane that has stopped for your word: a button per choice it laid out,
 * or a nudge to the composer when it asked freely. The reply goes back as a normal message.
 */
@Component({
  selector: 'orbit-ask-actions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { role: 'group', 'aria-label': 'Answer' },
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: 0.45rem;
        background: var(--surface);
        border: 1px solid #f59e0b;
        border-radius: 0.6rem;
        padding: 0.55rem 0.75rem;
      }
      h3 {
        margin: 0;
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: #f59e0b;
      }
      .options {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
      }
      .options button {
        padding: 0.35rem 0.8rem;
        font-size: 0.8rem;
        border-color: var(--edge-strong);
        max-width: 100%;
        text-align: left;
      }
      .options button:hover {
        border-color: #f59e0b;
      }
      .hint {
        color: var(--faint);
        font-size: 0.72rem;
      }
    `,
  ],
  template: `
    <h3>{{ ask().options.length ? 'Pick one, or reply below' : 'Waiting on your reply' }}</h3>
    @if (ask().options.length) {
      <div class="options">
        @for (o of ask().options; track o.reply) {
          <button type="button" [title]="'Sends: ' + o.reply" (click)="send.emit(o.reply)">
            {{ o.label }}
          </button>
        }
      </div>
    } @else {
      <span class="hint">Type your answer in the box below and press Send.</span>
    }
  `,
})
export class AskActions {
  readonly ask = input.required<Ask>();
  readonly send = output<string>();
}
