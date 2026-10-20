/** Nx targets and Angular CLI commands heavy enough to need a test slot. */
const HEAVY_TARGETS = new Set(['test', 'lint', 'build', 'e2e']);
/** npm scripts that run tests or builds: `test`, `test:unit`, `build:main`, `e2e`... */
const HEAVY_SCRIPT = /^(test|build|lint|e2e)([:\w-]*)$/;
/** Words that mean the command keeps running until someone stops it, so it would hold a slot forever. */
const LONG_RUNNING = new Set(['serve', 'watch', 'start', '--ui']);
/** `--watch`, `--watchAll`, and scripts like `test:watch` or `test-watch` run until stopped too. */
const WATCHING = /^--watch|[:-]watch\b/;
/** Wrappers that run the real command: `timeout 900 …`, `time …`, `env CI=1 …`, `nice -n 10 …`. */
const WRAPPERS = new Set(['timeout', 'time', 'env', 'nice']);

/** The program a segment runs and its arguments, past wrappers, env assignments, and `npx` and its flags. */
function words(segment: string): string[] {
  const all = segment
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/^["']+|["']+$/g, ''))
    .filter(Boolean);
  let i = 0;
  for (;;) {
    while (i < all.length && /^\w+=/.test(all[i])) i++;
    if (!WRAPPERS.has(all[i])) break;
    i++;
    // A wrapper's own flags and numbers: `timeout -k 5 900`, `nice -n 10`.
    while (i < all.length && (all[i].startsWith('-') || /^\d/.test(all[i]))) i++;
  }
  if (all[i] === 'npx') {
    i++;
    while (i < all.length && all[i].startsWith('-')) i++;
  }
  const rest = all.slice(i);
  if (rest.length) rest[0] = (rest[0].split(/[\\/]/).pop() ?? rest[0]).replace(/\.(cmd|exe)$/i, '');
  return rest;
}

function nxLabel(args: string[]): string | null {
  const [sub, next] = args;
  if (sub === 'affected' || sub === 'run-many') return `nx ${sub}`;
  if (HEAVY_TARGETS.has(sub)) return `nx ${sub}`;
  if (sub === 'run' && next) {
    const target = next.split(':')[1];
    return target && HEAVY_TARGETS.has(target) ? `nx ${target}` : null;
  }
  return null;
}

function npmLabel(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--prefix' || a === '-C') i++;
    else if (a === 'test' || a === 't') return 'npm test';
    else if (a === 'run' || a === 'run-script') {
      const script = args[i + 1] ?? '';
      return HEAVY_SCRIPT.test(script) ? `npm ${script}` : null;
    } else if (!a.startsWith('-')) return null;
  }
  return null;
}

function segmentLabel(segment: string): string | null {
  const [tool, ...args] = words(segment);
  if (!tool || args.some((a) => LONG_RUNNING.has(a) || WATCHING.test(a))) return null;
  switch (tool) {
    case 'bash':
    case 'sh':
      return args[0] === '-c' ? segmentLabel(args.slice(1).join(' ')) : null;
    case 'nx':
      return nxLabel(args);
    case 'jest':
    case 'vitest':
      return tool;
    case 'playwright':
      return args[0] === 'test' ? 'playwright' : null;
    case 'ng':
      return HEAVY_TARGETS.has(args[0]) ? `ng ${args[0]}` : null;
    case 'npm':
      return npmLabel(args);
    default:
      return null;
  }
}

/**
 * Whether a Bash command runs tests or a build that needs one of the shared test slots, and if so
 * a short label for the panel. Each part of a chained line counts on its own; the first heavy one
 * names it. Dev servers and watchers never count.
 */
export function heavyLabel(command: string): string | null {
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const label = segmentLabel(segment);
    if (label) return label;
  }
  return null;
}
