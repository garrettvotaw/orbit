import { ChangeDetectionStrategy, Component, effect, inject } from '@angular/core';
import { OrbitHome } from './orbit-home';
import { OrbitStore } from './orbit-store';
import { Titlebar } from './titlebar';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OrbitHome, Titlebar],
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        height: 100vh;
      }
    `,
  ],
  template: `
    <orbit-titlebar />
    <orbit-home />
  `,
})
export class App {
  readonly #store = inject(OrbitStore);

  constructor() {
    // The theme lives on <html> so every token, the scrollbars, and native controls follow it.
    effect(() => {
      document.documentElement.dataset['theme'] = this.#store.dark() ? 'dark' : 'light';
    });
  }
}
