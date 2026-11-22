import { describe, it, expect, vi, afterEach } from 'vitest';
import { pool, withRetry, fetchWithRetry } from '../../src/preview/net.js';

const profile = { tileRetries: 2, tileTimeoutMs: 1000 };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('pool', () => {
  it('runs every item and never exceeds the concurrency', async () => {
    let active = 0;
    let peak = 0;
    const seen = [];
    await pool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      seen.push(n);
      active--;
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBe(3);
  });

  it('handles an empty list', async () => {
    const fn = vi.fn();
    await pool([], 4, fn);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('withRetry', () => {
  it('returns the first success', async () => {
    const attempt = vi.fn().mockRejectedValueOnce(new Error('a')).mockResolvedValueOnce('ok');
    await expect(withRetry(attempt, profile)).resolves.toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('tries tileRetries + 1 times then throws the last error', async () => {
    const attempt = vi.fn()
      .mockRejectedValueOnce(new Error('1'))
      .mockRejectedValueOnce(new Error('2'))
      .mockRejectedValueOnce(new Error('3'));
    await expect(withRetry(attempt, profile)).rejects.toThrow('3');
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('stops immediately when the outer signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error('cancelled'));
    const attempt = vi.fn();
    await expect(withRetry(attempt, profile, ctrl.signal)).rejects.toThrow('cancelled');
    expect(attempt).not.toHaveBeenCalled();
  });

  it('aborts a hung attempt after tileTimeoutMs', async () => {
    vi.useFakeTimers();
    const signals = [];
    const attempt = (signal) => new Promise((_, reject) => {
      signals.push(signal);
      signal.addEventListener('abort', () => reject(new Error('timeout')));
    });
    const p = withRetry(attempt, { tileRetries: 0, tileTimeoutMs: 1000 });
    const assertion = expect(p).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(signals[0].aborted).toBe(true);
  });

  it('forwards an outer abort into the running attempt', async () => {
    const ctrl = new AbortController();
    let inner;
    const attempt = (signal) => new Promise((_, reject) => {
      inner = signal;
      signal.addEventListener('abort', () => reject(new Error('stopped')));
    });
    const p = withRetry(attempt, { tileRetries: 0, tileTimeoutMs: 60000 }, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toThrow('stopped');
    expect(inner.aborted).toBe(true);
  });
});

describe('fetchWithRetry', () => {
  it('retries 5xx and returns a 404 as final', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    const res = await fetchWithRetry('https://x/1', {}, profile);
    expect(res.status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('throws after repeated server errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));
    await expect(fetchWithRetry('https://x/1', {}, profile)).rejects.toThrow('HTTP 500');
  });
});
