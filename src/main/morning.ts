export function planMorning(morning: string[], isLive: (id: string) => boolean): string[] {
  return morning.filter((id) => !isLive(id));
}

export function runMorning(
  ids: string[],
  start: (id: string) => void,
  staggerMs = 10_000,
  setTimeoutFn: typeof setTimeout = setTimeout,
): void {
  ids.forEach((id, i) => {
    if (i === 0) start(id);
    else setTimeoutFn(() => start(id), staggerMs * i);
  });
}
