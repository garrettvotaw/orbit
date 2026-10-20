export class PushableStream<T> implements AsyncIterable<T> {
  readonly #queue: T[] = [];
  #waiter: ((r: IteratorResult<T>) => void) | null = null;
  #closed = false;

  get ended(): boolean {
    return this.#closed;
  }

  push(item: T): void {
    if (this.#closed) return;
    if (this.#waiter) {
      const w = this.#waiter;
      this.#waiter = null;
      w({ value: item, done: false });
    } else this.#queue.push(item);
  }

  end(): void {
    this.#closed = true;
    if (this.#waiter) {
      const w = this.#waiter;
      this.#waiter = null;
      w({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.#queue.length) return Promise.resolve({ value: this.#queue.shift() as T, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<T>>((resolve) => {
          this.#waiter = resolve;
        });
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}
