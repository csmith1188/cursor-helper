let chain = Promise.resolve();

/**
 * Serialize async work so overlapping webhook deliveries cannot interleave Git ops.
 */
export function withLock(fn) {
  const run = chain.then(() => fn());
  // Keep the chain alive even if a task fails
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
