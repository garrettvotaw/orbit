import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { OrbitStore } from './orbit-store';
import { renderMarkdown } from './pure/markdown';
import type { FeedEntry } from '../../../shared/types';

/** How close to the bottom still counts as "following the tail". */
const PIN_SLACK_PX = 24;

/** Renders a conversation feed: your messages, the assistant's text as markdown, tool one-liners, folded results. */
@Component({
  selector: 'orbit-feed-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: block;
        overflow: auto;
        font-size: 0.85rem;
      }
      .list {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
      }
      .text {
        color: var(--text);
        border-left: 2px solid var(--edge);
        padding-left: 0.6rem;
        line-height: 1.45;
        overflow-wrap: anywhere;
      }
      .text ::ng-deep > :first-child {
        margin-top: 0;
      }
      .text ::ng-deep > :last-child {
        margin-bottom: 0;
      }
      .text ::ng-deep p,
      .text ::ng-deep ul,
      .text ::ng-deep ol,
      .text ::ng-deep blockquote,
      .text ::ng-deep pre,
      .text ::ng-deep table {
        margin: 0.35rem 0;
      }
      .text ::ng-deep h1,
      .text ::ng-deep h2,
      .text ::ng-deep h3,
      .text ::ng-deep h4 {
        margin: 0.6rem 0 0.3rem;
        font-size: 0.95rem;
        line-height: 1.3;
      }
      .text ::ng-deep h1 {
        font-size: 1.05rem;
      }
      .text ::ng-deep ul,
      .text ::ng-deep ol {
        padding-left: 1.3rem;
      }
      .text ::ng-deep li + li {
        margin-top: 0.2rem;
      }
      .text ::ng-deep code {
        font-family: ui-monospace, monospace;
        font-size: 0.8em;
        background: var(--surface);
        border: 1px solid var(--edge);
        border-radius: 0.25rem;
        padding: 0 0.3rem;
      }
      .text ::ng-deep pre {
        background: var(--surface);
        border: 1px solid var(--edge);
        border-radius: 0.4rem;
        padding: 0.5rem 0.6rem;
        overflow: auto;
      }
      .text ::ng-deep pre code {
        background: transparent;
        border: 0;
        padding: 0;
        white-space: pre;
      }
      .text ::ng-deep blockquote {
        border-left: 2px solid var(--dim);
        margin-left: 0;
        padding-left: 0.6rem;
        color: var(--muted);
      }
      .text ::ng-deep a {
        color: var(--link);
      }
      .text ::ng-deep table {
        border-collapse: collapse;
        font-size: 0.8rem;
      }
      .text ::ng-deep th,
      .text ::ng-deep td {
        border: 1px solid var(--edge);
        padding: 0.2rem 0.45rem;
        text-align: left;
      }
      .text ::ng-deep hr {
        border: 0;
        border-top: 1px solid var(--edge);
      }
      .user {
        white-space: pre-wrap;
        color: var(--link);
        border-left: 2px solid #3b82f6;
        padding-left: 0.6rem;
      }
      .tool {
        color: var(--muted);
        font-family: ui-monospace, monospace;
        font-size: 0.78rem;
      }
      .tool::before {
        content: '▸ ';
        color: var(--faint);
      }
      details {
        font-size: 0.78rem;
        color: var(--muted);
      }
      summary {
        cursor: pointer;
        color: var(--faint);
      }
      pre {
        white-space: pre-wrap;
        margin: 0.3rem 0 0;
        font-family: ui-monospace, monospace;
        color: var(--muted);
      }
      .note {
        color: var(--faint);
      }
    `,
  ],
  template: `
    <div class="list" #list (click)="onClick($event)">
      @if (loading()) {
        <div class="note">Reading the transcript…</div>
      }
      @for (e of entries(); track $index) {
        @switch (e.kind) {
          @case ('text') {
            <div class="text" [innerHTML]="markdown(e.text)"></div>
          }
          @case ('user') {
            <div class="user">{{ e.text }}</div>
          }
          @case ('tool') {
            <div class="tool">{{ e.text }}</div>
          }
          @case ('result') {
            <details>
              <summary>{{ e.tool ?? 'result' }} result</summary>
              <pre>{{ e.text }}</pre>
            </details>
          }
        }
      }
      @if (note(); as n) {
        <div class="note">{{ n }}</div>
      }
    </div>
  `,
})
export class FeedView {
  readonly #store = inject(OrbitStore);
  readonly entries = input<FeedEntry[]>([]);
  readonly note = input<string | null>(null);
  readonly loading = input(false);
  /** Keep the newest entry in view as the conversation grows, unless you have scrolled up to read. */
  readonly followTail = input(true);
  /** Which conversation this is; a new one starts pinned to its newest entry again. */
  readonly conversation = input<string>('');
  private readonly list = viewChild.required<ElementRef<HTMLElement>>('list');
  #pinned = true;
  #top = 0;
  #lastConversation: string | null = null;
  readonly #rendered = new Map<string, string>();

  markdown(text: string): string {
    let html = this.#rendered.get(text);
    if (html === undefined) {
      html = renderMarkdown(text);
      if (this.#rendered.size > 500) this.#rendered.clear();
      this.#rendered.set(text, html);
    }
    return html;
  }

  /** Links in the transcript open in your browser; the window itself never navigates. */
  onClick(event: Event): void {
    const a = (event.target as HTMLElement | null)?.closest('a');
    if (!a) return;
    event.preventDefault();
    const href = a.getAttribute('href') ?? '';
    if (/^https?:\/\//.test(href)) this.#store.open(href);
  }

  constructor(host: ElementRef<HTMLElement>) {
    const el = host.nativeElement;
    el.addEventListener('scroll', () => {
      this.#pinned = el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_SLACK_PX;
      this.#top = el.scrollTop;
    });
    afterRenderEffect(() => {
      this.entries();
      this.note();
      this.loading();
      this.list();
      const conversation = this.conversation();
      if (conversation !== this.#lastConversation) {
        this.#lastConversation = conversation;
        this.#pinned = true;
      }
      if (!this.followTail()) return;
      // Pinned: follow the newest line. Otherwise hold the place you scrolled to, whatever the
      // browser's own anchoring made of the re-render.
      el.scrollTop = this.#pinned ? el.scrollHeight : this.#top;
    });
  }
}
