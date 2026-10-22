// Fetch helpers: bounded concurrency, per-request timeout, retries.

export async function pool(items, concurrency, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

// Runs `attempt(signal)` with a timeout, retrying on failure. A 404 (or any
// result `attempt` returns rather than throws) is final.
export async function withRetry(attempt, profile, outerSignal) {
  let lastErr;
  for (let tryNo = 0; tryNo <= profile.tileRetries; tryNo++) {
    if (outerSignal?.aborted) throw outerSignal.reason || new Error('aborted');
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    outerSignal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), profile.tileTimeoutMs);
    try {
      return await attempt(ctrl.signal);
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastErr;
}

export function fetchWithRetry(url, init, profile, signal) {
  return withRetry(async (s) => {
    const res = await fetch(url, { ...init, signal: s });
    if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
    return res;
  }, profile, signal);
}
