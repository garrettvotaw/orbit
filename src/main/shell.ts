import { app, BrowserWindow, Menu, nativeImage, nativeTheme, Notification, Tray } from 'electron';
import path from 'node:path';
import type { AttentionItem, HostSnapshot, Theme } from '../shared/types.ts';

export interface ShellDeps {
  rendererIndex: string;
  preload: string;
  assets: string;
  onMorning: () => void;
  onEvening: () => void;
  toastEnabled: () => boolean;
}

/** Window chrome colors per theme; they match the renderer's --bg and --muted tokens. */
const CHROME = {
  dark: { bg: '#0f1218', symbol: '#9fb0c6' },
  light: { bg: '#f4f6fa', symbol: '#475569' },
} as const;
const BG = CHROME.dark.bg;
/** Height of the renderer's title strip; the caption buttons overlay is sized to match. */
export const TITLE_BAR_HEIGHT = 36;
const TRAY_PULSE_MS = 1200;

export class Shell {
  #win: BrowserWindow | null = null;
  #tray: Tray | null = null;
  #quitting = false;
  #pulse: ReturnType<typeof setInterval> | null = null;
  #theme: Theme = 'system';
  readonly #seenAttention = new Set<string>();
  readonly #deps: ShellDeps;

  constructor(deps: ShellDeps) {
    this.#deps = deps;
  }

  create(opts: { show?: boolean } = {}): BrowserWindow {
    // No menu bar: the renderer draws its own title strip and Windows paints only the
    // caption buttons, in the app's colors, over it.
    Menu.setApplicationMenu(null);
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 900,
      minHeight: 600,
      show: opts.show ?? true,
      backgroundColor: BG,
      title: 'Orbit',
      icon: path.join(this.#deps.assets, 'orbit.ico'),
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: BG, symbolColor: CHROME.dark.symbol, height: TITLE_BAR_HEIGHT },
      webPreferences: { preload: this.#deps.preload, contextIsolation: true, sandbox: true },
    });
    void win.loadFile(this.#deps.rendererIndex);
    // The renderer is a single page; a link that slips through its own handler must not take it over.
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      const key = input.key.toLowerCase();
      if (key === 'f12') win.webContents.toggleDevTools();
      else if (input.control && key === 'r' && !app.isPackaged) win.webContents.reload();
      else if (input.control && key === 'q') this.quit();
      else return;
      e.preventDefault();
    });
    win.on('close', (e) => {
      if (!this.#quitting) {
        e.preventDefault();
        win.hide();
      }
    });
    app.on('before-quit', () => {
      this.#quitting = true;
    });
    this.#win = win;
    nativeTheme.on('updated', () => {
      if (this.#theme === 'system') this.#paintChrome();
    });

    const tray = new Tray(nativeImage.createFromPath(path.join(this.#deps.assets, 'orbit.ico')));
    tray.setToolTip('Orbit');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Show Orbit', click: () => this.show() },
        { label: 'Morning start', click: () => this.#deps.onMorning() },
        { label: 'End the day', click: () => this.#deps.onEvening() },
        { type: 'separator' },
        { label: 'Quit', click: () => this.quit() },
      ]),
    );
    tray.on('click', () => this.show());
    this.#tray = tray;
    return win;
  }

  /** Paint the window chrome for a theme; 'system' follows Windows and re-paints when it flips. */
  setTheme(theme: Theme): void {
    this.#theme = theme;
    nativeTheme.themeSource = theme;
    this.#paintChrome();
  }

  #paintChrome(): void {
    const dark = this.#theme === 'system' ? nativeTheme.shouldUseDarkColors : this.#theme === 'dark';
    const c = dark ? CHROME.dark : CHROME.light;
    this.#win?.setBackgroundColor(c.bg);
    this.#win?.setTitleBarOverlay({ color: c.bg, symbolColor: c.symbol, height: TITLE_BAR_HEIGHT });
  }

  show(): void {
    this.#win?.show();
    this.#win?.focus();
  }

  quit(): void {
    this.#quitting = true;
    app.quit();
  }

  send(channel: string, payload: unknown): void {
    this.#win?.webContents.send(channel, payload);
  }

  /** Update the badge and fire a toast for every attention item not seen before. */
  reflect(snapshot: HostSnapshot): void {
    const n = snapshot.attention.length;
    this.#win?.setTitle(n ? `(${n}) Orbit` : 'Orbit');
    this.#tray?.setToolTip(n ? `Orbit · ${n} need you` : 'Orbit');
    this.#pulseTray(n > 0);
    for (const item of snapshot.attention) {
      if (this.#seenAttention.has(item.id)) continue;
      this.#seenAttention.add(item.id);
      if (this.#deps.toastEnabled()) this.#toast(item, snapshot);
    }
    for (const id of [...this.#seenAttention]) {
      if (!snapshot.attention.some((i) => i.id === id)) this.#seenAttention.delete(id);
    }
  }

  /** While something needs you the tray icon breathes amber; otherwise it rests on the plain mark. */
  #pulseTray(on: boolean): void {
    const icon = (name: string) => nativeImage.createFromPath(path.join(this.#deps.assets, name));
    if (!on) {
      if (this.#pulse) clearInterval(this.#pulse);
      this.#pulse = null;
      this.#tray?.setImage(icon('orbit.ico'));
      return;
    }
    if (this.#pulse) return;
    let lit = true;
    this.#tray?.setImage(icon('orbit-alert.ico'));
    this.#pulse = setInterval(() => {
      lit = !lit;
      this.#tray?.setImage(icon(lit ? 'orbit-alert.ico' : 'orbit.ico'));
    }, TRAY_PULSE_MS);
    this.#pulse.unref?.();
  }

  /** A plain notification that opens the window when clicked. */
  toastText(title: string, body: string): void {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: true });
    n.on('click', () => this.show());
    n.show();
  }

  #toast(item: AttentionItem, snapshot: HostSnapshot): void {
    if (!Notification.isSupported()) return;
    const lane = snapshot.lanes.find((l) => l.id === item.laneId)?.name ?? item.laneId;
    const body =
      item.kind === 'question'
        ? (item.questions[0]?.header ?? 'has a question')
        : item.kind === 'blocked'
          ? item.decision || `Blocked: ${item.story}`
          : `Error: ${item.code}`;
    const n = new Notification({ title: `${lane} needs you`, body, silent: true });
    n.on('click', () => this.show());
    n.show();
  }
}
