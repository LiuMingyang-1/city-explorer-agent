import { setTimeout as delay } from "node:timers/promises";
import { ChannelError } from "./types.ts";
import type { Clock, Context, SearchAdapter, AdapterQuery, AdapterPage } from "./types.ts";
export const realClock: Clock = { now: () => Date.now(), sleep: async (ms, signal) => { await delay(ms, undefined, { signal }); } };
export function abortError(): Error { return new DOMException("Search cancelled", "AbortError"); }
/** Every losing branch is observed and its listener/timer removed. */
export function interruptible<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason ?? abortError());
    if (signal.aborted) { stop(); promise.catch(() => {}); return; }
    signal.addEventListener("abort", stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}
export function deadline(clock: Clock, at: number, parent: AbortSignal) {
  const controller = new AbortController(), timer = new AbortController();
  const stop = () => controller.abort(parent.reason ?? abortError());
  parent.addEventListener("abort", stop, { once: true });
  if (parent.aborted) stop();
  if (at <= clock.now()) controller.abort(new ChannelError("TIMEOUT"));
  else void clock.sleep(at - clock.now(), timer.signal).then(() => controller.abort(new ChannelError("TIMEOUT")), () => {});
  return { signal: controller.signal, dispose() { timer.abort(); parent.removeEventListener("abort", stop); } };
}
export class Scheduler {
  private active = 0;
  private channels = new Map<string, number>();
  private listeners = new Set<() => void>();
  private pending = new Set<Promise<unknown>>();
  clock: Clock;
  private concurrency: number;
  private timeoutMs: number;
  constructor(clock: Clock = realClock, concurrency = 4, timeoutMs = 5000) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("INVALID_SCHEDULER_CONFIG");
    this.clock = clock; this.concurrency = concurrency; this.timeoutMs = timeoutMs;
  }
  private async acquire(a: SearchAdapter, signal: AbortSignal) {
    const key = a.capabilities.channel;
    while (true) {
      signal.throwIfAborted();
      if (this.active < this.concurrency && (this.channels.get(key) ?? 0) < a.capabilities.maxConcurrency) {
        this.active++; this.channels.set(key, (this.channels.get(key) ?? 0) + 1);
        return () => { this.active--; this.channels.set(key, this.channels.get(key)! - 1); for (const wake of [...this.listeners]) wake(); };
      }
      await new Promise<void>((resolve, reject) => {
        const clean = () => { this.listeners.delete(wake); signal.removeEventListener("abort", stop); };
        const wake = () => { clean(); resolve(); };
        const stop = () => { clean(); reject(signal.reason ?? abortError()); };
        this.listeners.add(wake); signal.addEventListener("abort", stop, { once: true });
      });
    }
  }
  async page(a: SearchAdapter, query: AdapterQuery, context: Context): Promise<AdapterPage> {
    for (let attempt = 0; ; attempt++) {
      context.signal.throwIfAborted();
      const release = await this.acquire(a, context.signal);
      const child = deadline(this.clock, Math.min(context.deadlineAt, this.clock.now() + this.timeoutMs), context.signal);
      const task = Promise.resolve().then(() => { child.signal.throwIfAborted(); return a.search(query, { ...context, signal: child.signal }); });
      const settled = task.then(() => {}, () => {}).finally(() => { release(); this.pending.delete(settled); });
      this.pending.add(settled);
      try { return await interruptible(task, child.signal); }
      catch (error) {
        context.signal.throwIfAborted();
        const retryable = error instanceof ChannelError && ["TIMEOUT", "RATE_LIMITED", "NETWORK_ERROR"].includes(error.code);
        if (!retryable || attempt >= 1) throw error;
        const wait = Math.max(200, error.retryAfterMs);
        if (this.clock.now() + wait >= context.deadlineAt) throw error;
        await this.clock.sleep(wait, context.signal);
      } finally { child.dispose(); }
    }
  }
  async drain() { await Promise.allSettled([...this.pending]); }
}
