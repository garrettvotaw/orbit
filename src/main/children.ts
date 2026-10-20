import { type ChildProcess, spawn, spawnSync } from 'node:child_process';

export interface SpawnRequest {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
}

/**
 * A binary cannot run from inside an asar archive. The packaged app ships the CLI unpacked
 * next to the archive, so a path the SDK resolves inside `app.asar` is redirected there.
 */
export function unpacked(command: string): string {
  return command.replace(/([\\/])app\.asar(?=[\\/])/, '$1app.asar.unpacked');
}

/** Spawns Claude Code processes on the SDK's behalf and can force-kill every tree that is still alive. */
export class ChildTracker {
  readonly #children = new Set<ChildProcess>();
  /** The lane each child runs for, from the ORBIT_LANE the session host puts in its env. */
  readonly #lanes = new WeakMap<ChildProcess, string>();

  get size(): number {
    return this.#children.size;
  }

  spawn(req: SpawnRequest): ChildProcess {
    const child = spawn(unpacked(req.command), req.args, {
      cwd: req.cwd,
      env: req.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: req.signal,
      windowsHide: true,
    });
    this.#children.add(child);
    if (req.env.ORBIT_LANE) this.#lanes.set(child, req.env.ORBIT_LANE);
    child.once('exit', () => this.#children.delete(child));
    child.once('error', () => this.#children.delete(child));
    return child;
  }

  /**
   * Kill one lane's process trees now. Stopping a CLI on Windows can leave the nx and Jest it
   * started running; this takes them down too. Returns whether there was anything to kill.
   */
  killLane(laneId: string): boolean {
    let killed = false;
    for (const child of [...this.#children]) {
      if (this.#lanes.get(child) !== laneId || !alive(child)) continue;
      killTree(child);
      killed = true;
    }
    return killed;
  }

  /** Give children `graceMs` to exit on their own, then kill whatever is left, including grandchildren. */
  async killAll(graceMs = 1_000): Promise<void> {
    if (!this.#children.size) return;
    await new Promise((r) => setTimeout(r, graceMs));
    for (const child of [...this.#children]) if (alive(child)) killTree(child);
    this.#children.clear();
  }
}

function alive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null && child.pid !== undefined;
}

function killTree(child: ChildProcess): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}
