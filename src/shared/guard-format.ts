const GB = 1024 ** 3;

/** Memory as the panel and the alert say it: `16.6 GB`. */
export function formatGb(bytes: number): string {
  return `${(bytes / GB).toFixed(1)} GB`;
}

/** How long something has run: `40s`, `3m`, `1h 5m`. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
