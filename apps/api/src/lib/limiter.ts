/** Runs at most `max` of the wrapped calls at once; the rest wait their turn in order. */
export function limiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < max) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await fn();
    } finally {
      // Hand the slot straight to the next waiter, or free it.
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
