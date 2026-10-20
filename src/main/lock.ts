import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

interface LockInfo {
  pid: number;
  exe: string;
  since: number;
}

/**
 * One Orbit per config. The Electron single-instance lock is per install, so a dev run and the
 * installed app would otherwise both drive the same lanes; this lock lives beside the config.
 */
export class ConfigLock {
  readonly #file: string;
  #held = false;

  constructor(configDir: string) {
    this.#file = path.join(configDir, 'orbit.lock');
  }

  /** The other Orbit holding this config, or null when the lock was taken. */
  acquire(pid = process.pid, exe = process.execPath, isAlive: (pid: number) => boolean = alive): LockInfo | null {
    const other = this.#read();
    if (other && other.pid !== pid && isAlive(other.pid)) return other;
    mkdirSync(path.dirname(this.#file), { recursive: true });
    writeFileSync(this.#file, JSON.stringify({ pid, exe, since: Date.now() } satisfies LockInfo));
    this.#held = true;
    return null;
  }

  release(): void {
    if (!this.#held) return;
    try {
      unlinkSync(this.#file);
    } catch {
      // already gone
    }
    this.#held = false;
  }

  #read(): LockInfo | null {
    if (!existsSync(this.#file)) return null;
    try {
      const o = JSON.parse(readFileSync(this.#file, 'utf8')) as Partial<LockInfo>;
      return typeof o.pid === 'number' ? { pid: o.pid, exe: o.exe ?? '', since: o.since ?? 0 } : null;
    } catch {
      return null;
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
