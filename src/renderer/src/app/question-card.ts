import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { OrbitStore } from './orbit-store';
import {
  answered,
  buildReply,
  EMPTY_DRAFT,
  pick,
  typeOther,
  type QuestionDraft,
} from './pure/question-reply';
import type { Question, QuestionItem } from '../../../shared/types';

@Component({
  selector: 'orbit-question-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  styles: [
    `
      :host {
        display: block;
        background: var(--panel-bg);
        backdrop-filter: blur(14px) saturate(1.2);
        box-shadow: var(--panel-shadow);
        isolation: isolate;
        border: 1px solid #f59e0b;
        border-radius: 0.75rem;
        padding: 1rem;
        width: min(28rem, 90vw);
      }
      /* Inside a lane panel the card is one more section, not a floating one. */
      :host(.inline) {
        flex: none;
        width: auto;
        box-shadow: none;
      }
      h3 {
        margin: 0 0 0.25rem;
        font-size: 0.9rem;
        color: #f59e0b;
      }
      .why {
        color: var(--muted);
        font-size: 0.75rem;
        margin-bottom: 0.75rem;
      }
      fieldset {
        border: 0;
        padding: 0;
        margin: 0 0 0.75rem;
      }
      legend {
        font-weight: 600;
        margin-bottom: 0.4rem;
      }
      .chip {
        display: inline-block;
        margin-right: 0.4rem;
        padding: 0.05rem 0.5rem;
        border: 1px solid var(--edge-strong);
        border-radius: 999px;
        font-size: 0.7rem;
        font-weight: 500;
        color: var(--muted);
        vertical-align: 0.1em;
      }
      label {
        display: block;
        padding: 0.3rem 0;
      }
      label small {
        display: block;
        color: var(--muted);
      }
      .preview {
        margin: 0.3rem 0;
        max-height: 12rem;
        overflow: auto;
        padding: 0.5rem 0.6rem;
        background: var(--bg);
        border: 1px solid var(--edge);
        border-radius: 0.4rem;
        font: 0.75rem/1.4 var(--mono);
        white-space: pre;
      }
      input[type='text'] {
        width: 100%;
        box-sizing: border-box;
        background: var(--bg);
        color: inherit;
        border: 1px solid var(--edge);
        border-radius: 0.4rem;
        padding: 0.4rem 0.6rem;
      }
      .actions {
        display: flex;
        gap: 0.5rem;
        justify-content: flex-end;
      }
    `,
  ],
  template: `
    <h3>{{ laneName() }} is asking</h3>
    @if (item().why) {
      <div class="why">{{ item().why }}</div>
    }
    <form (ngSubmit)="submit()">
      @for (q of item().questions; track q.question; let qi = $index) {
        <fieldset>
          <legend>
            @if (q.header) {
              <span class="chip">{{ q.header }}</span>
            }
            <span>{{ q.question }}</span>
          </legend>
          @for (o of q.options; track o.label) {
            <label (mouseenter)="focus(qi, o.label)">
              <input
                [type]="q.multiSelect ? 'checkbox' : 'radio'"
                [name]="'q' + qi"
                [value]="o.label"
                [checked]="isChecked(qi, o.label)"
                (focus)="focus(qi, o.label)"
                (change)="toggle(qi, o.label, q.multiSelect)"
              />
              {{ o.label }} <small>{{ o.description }}</small>
            </label>
          }
          @if (previewFor(qi, q); as preview) {
            <pre class="preview" [attr.aria-label]="'Preview for ' + q.header">{{ preview }}</pre>
          }
          <label>
            Other
            <input
              type="text"
              [attr.aria-label]="'Other answer for ' + q.header"
              [ngModel]="draft(qi).other"
              (ngModelChange)="setOther(qi, $event, q.multiSelect)"
              [ngModelOptions]="{ standalone: true }"
              [placeholder]="q.multiSelect ? 'add your own' : 'type your own instead'"
            />
          </label>
          <label>
            Notes
            <input
              type="text"
              [attr.aria-label]="'Notes for ' + q.header"
              [ngModel]="draft(qi).notes"
              (ngModelChange)="setNotes(qi, $event)"
              [ngModelOptions]="{ standalone: true }"
              placeholder="optional, goes along with your answer"
            />
          </label>
        </fieldset>
      }
      <div class="actions">
        <button type="button" (click)="store.command({ type: 'dismiss', attentionId: item().id })">
          Dismiss
        </button>
        <button type="submit" [disabled]="!complete()">Answer</button>
      </div>
    </form>
  `,
})
export class QuestionCard {
  readonly store = inject(OrbitStore);
  readonly #cdr = inject(ChangeDetectorRef);
  readonly item = input.required<QuestionItem>();
  /** The item by id: a fresh snapshot of the same question must not wipe what you have entered. */
  readonly #question = computed(() => this.item(), { equal: (a, b) => a.id === b.id });
  readonly drafts = linkedSignal<QuestionDraft[]>(() =>
    this.#question().questions.map(() => EMPTY_DRAFT),
  );
  /** The option the pointer or keyboard is on, per question, so its preview shows. */
  readonly focused = linkedSignal<Record<number, string>>(() => {
    this.#question();
    return {};
  });
  readonly complete = computed(() => this.drafts().every(answered));

  laneName(): string {
    return this.store.lanes().find((l) => l.id === this.item().laneId)?.name ?? this.item().laneId;
  }

  draft(qi: number): QuestionDraft {
    return this.drafts()[qi] ?? EMPTY_DRAFT;
  }

  isChecked(qi: number, label: string): boolean {
    return this.draft(qi).picked.includes(label);
  }

  toggle(qi: number, label: string, multi: boolean): void {
    this.#edit(qi, (d) => pick(d, label, multi));
  }

  setOther(qi: number, value: string, multi: boolean): void {
    this.#edit(qi, (d) => typeOther(d, value, multi));
  }

  setNotes(qi: number, notes: string): void {
    this.#edit(qi, (d) => ({ ...d, notes }));
  }

  focus(qi: number, label: string): void {
    this.focused.update((f) => ({ ...f, [qi]: label }));
  }

  /** The focused option's preview, else the picked one's; only questions that carry previews show one. */
  previewFor(qi: number, q: Question): string | null {
    const label = this.focused()[qi] ?? this.draft(qi).picked[0];
    return q.options.find((o) => o.label === label)?.preview ?? null;
  }

  submit(): void {
    const { answers, annotations } = buildReply(this.item().questions, this.drafts());
    void this.store.command({
      type: 'answer',
      attentionId: this.item().id,
      answers,
      ...(annotations ? { annotations } : {}),
    });
  }

  /**
   * Render each edit before the next event. A click checks a radio in the DOM on its own; if a
   * second edit unpicks it before change detection runs, the [checked] binding never sees the
   * change and the radio stays checked against the model.
   */
  #edit(qi: number, fn: (d: QuestionDraft) => QuestionDraft): void {
    this.drafts.update((all) => all.map((d, i) => (i === qi ? fn(d) : d)));
    this.#cdr.detectChanges();
  }
}
