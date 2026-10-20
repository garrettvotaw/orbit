import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Odometer } from './odometer';
import { OrbitStore } from './orbit-store';
import { formatSpentToday } from './pure/layout';
import type { Theme } from '../../../shared/types';

/**
 * The window's title strip. Windows paints only its caption buttons over the top-right corner
 * (`titlebar-area-*`), so this draws the rest: the mark, the name, and a nudge when something
 * needs you. The whole strip drags the window.
 */
@Component({
  selector: 'orbit-titlebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Odometer],
  host: { role: 'banner' },
  styles: [
    `
      :host {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        box-sizing: border-box;
        height: env(titlebar-area-height, 36px);
        width: env(titlebar-area-width, 100%);
        padding: 0 0.75rem;
        color: var(--muted);
        font-size: 0.8rem;
        user-select: none;
        -webkit-app-region: drag;
        flex: none;
      }
      svg {
        width: 1.1rem;
        height: 1.1rem;
        flex: none;
      }
      svg.alert {
        animation: beacon 1.6s ease-in-out infinite;
      }
      @keyframes beacon {
        0%,
        100% {
          filter: drop-shadow(0 0 0 rgba(245, 158, 11, 0));
        }
        50% {
          filter: drop-shadow(0 0 6px rgba(245, 158, 11, 0.9));
        }
      }
      .name {
        color: var(--text);
        font-family: var(--display);
        font-weight: 700;
        letter-spacing: 0.04em;
      }
      .needs {
        color: #f59e0b;
      }
      .needs::before {
        content: '·';
        margin-right: 0.5rem;
        color: var(--dim);
      }
      .spent {
        margin-left: auto;
        color: var(--faint);
        display: inline-flex;
        gap: 0.35rem;
        align-items: baseline;
      }
      .theme {
        -webkit-app-region: no-drag;
        margin: 0 0.5rem 0 0.75rem;
        padding: 0.1rem 0.45rem;
        font-size: 0.8rem;
        line-height: 1.4;
        border-radius: 0.4rem;
        background: transparent;
        border-color: transparent;
        color: var(--muted);
      }
      .theme:hover {
        background: var(--hover);
        border-color: var(--edge);
      }
    `,
  ],
  template: `
    <!-- The app icon's open orbit at its small-size weight (scripts/make-icons.mjs); the moon turns amber when something needs you. -->
    <svg viewBox="0 0 256 256" aria-hidden="true" [class.alert]="needs() > 0">
      <defs>
        <linearGradient id="title-arc" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stop-color="#4a1fd0" />
          <stop offset=".6" stop-color="#7c5cff" />
          <stop offset="1" stop-color="#a78bfa" />
        </linearGradient>
      </defs>
      <path
        d="M 207.2 114.8 A 82 82 0 1 1 149.2 56.8"
        fill="none"
        stroke="url(#title-arc)"
        stroke-width="48"
        stroke-linecap="round"
      />
      <circle cx="196" cy="68" r="28" [attr.fill]="needs() ? '#f59e0b' : '#b19bff'" />
    </svg>
    <span class="name">Orbit</span>
    @if (needs(); as n) {
      <span class="needs">{{ n }} need{{ n === 1 ? 's' : '' }} you</span>
    }
    <span
      class="spent"
      title="What every lane has spent today, across sessions; ~ while a turn is still running"
    >
      today <orbit-odometer [value]="spent()" />
    </span>
    <button
      class="theme"
      type="button"
      [attr.aria-label]="themeLabel()"
      [title]="themeLabel()"
      (click)="cycleTheme()"
    >
      {{ themeGlyph() }}
    </button>
  `,
})
export class Titlebar {
  readonly #store = inject(OrbitStore);
  readonly needs = computed(() => this.#store.attention().length);
  readonly spent = computed(() =>
    formatSpentToday(this.#store.spentTodayUsd(), this.#store.lanes()),
  );
  readonly themeGlyph = computed(() => {
    const mode = this.#store.themeMode();
    return mode === 'system' ? '◐' : mode === 'dark' ? '☾' : '☀';
  });
  readonly themeLabel = computed(() => {
    const mode = this.#store.themeMode();
    const next = NEXT_THEME[mode];
    return `Theme: ${mode === 'system' ? 'follows Windows' : mode}. Click for ${next === 'system' ? 'follow Windows' : next}.`;
  });

  cycleTheme(): void {
    this.#store.setTheme(NEXT_THEME[this.#store.themeMode()]);
  }
}

const NEXT_THEME: Record<Theme, Theme> = { dark: 'light', light: 'system', system: 'dark' };
