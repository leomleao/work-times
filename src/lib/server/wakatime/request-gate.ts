import {
  MIN_UPSTREAM_REQUEST_SPACING_MS,
  MAX_CONCURRENT_UPSTREAM_REQUESTS
} from '../sync/contracts.js';

export interface GatePermit {
  /**
   * Release the permit when request execution (including body streaming) completes.
   */
  release(): void;
}

export type DelayFunction = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface RequestGateOptions {
  /** Minimum time in milliseconds between the start of consecutive requests (default: 1000). */
  minSpacingMs?: number;
  /** Maximum concurrent in-flight requests (default: 1). */
  maxConcurrent?: number;
  /** Injected clock for deterministic testing (default: Date.now). */
  now?: () => number;
  /** Injected sleep/delay function for deterministic testing. */
  delay?: DelayFunction;
}

interface QueuedItem {
  id: number;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (permit: GatePermit) => void;
  reject: (err: unknown) => void;
}

/**
 * Standard abortable delay implementation.
 */
export async function defaultGateDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) {
    throw signal.reason ?? new Error('Request aborted');
  }

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? new Error('Request aborted'));
    };

    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Shared Application Request Gate.
 *
 * Enforces:
 * 1. Strictly 1 concurrent in-flight upstream HTTP request (MAX_CONCURRENT_UPSTREAM_REQUESTS).
 * 2. At least 1000ms between consecutive request starts (MIN_UPSTREAM_REQUEST_SPACING_MS).
 * 3. Token acquisition occurs outside of permit hold so refresh cannot deadlock.
 * 4. Fake-clock friendly via injected now() and delay().
 * 5. Full cancellation propagation across permit queue waiting and pacing delays.
 */
export class WakaTimeRequestGate {
  readonly minSpacingMs: number;
  readonly maxConcurrent: number;
  readonly #now: () => number;
  readonly #delay: DelayFunction;

  #activeCount = 0;
  #lastRequestStartTime: number | null = null;
  #queue: QueuedItem[] = [];
  #nextItemId = 1;
  #processing = false;
  #historyStartTimes: number[] = [];

  constructor(options?: RequestGateOptions) {
    this.minSpacingMs = options?.minSpacingMs ?? MIN_UPSTREAM_REQUEST_SPACING_MS;
    this.maxConcurrent = options?.maxConcurrent ?? MAX_CONCURRENT_UPSTREAM_REQUESTS;
    this.#now = options?.now ?? (() => Date.now());
    this.#delay = options?.delay ?? defaultGateDelay;
  }

  get activeCount(): number {
    return this.#activeCount;
  }

  get queuedCount(): number {
    return this.#queue.length;
  }

  get lastRequestStartTime(): number | null {
    return this.#lastRequestStartTime;
  }

  get requestStartTimes(): readonly number[] {
    return this.#historyStartTimes;
  }

  /**
   * Acquire a permit to start an upstream request.
   * Resolves when the request is authorized to start.
   * Must call permit.release() when the request finishes.
   */
  async acquire(options?: { signal?: AbortSignal }): Promise<GatePermit> {
    const signal = options?.signal;
    if (signal?.aborted) {
      throw signal.reason ?? new Error('Request aborted before acquiring permit');
    }

    return new Promise<GatePermit>((resolve, reject) => {
      const item: QueuedItem = {
        id: this.#nextItemId++,
        signal,
        resolve,
        reject
      };

      if (signal) {
        const onAbort = () => {
          this.#removeFromQueue(item.id);
          reject(signal.reason ?? new Error('Request aborted while waiting in request gate queue'));
        };
        item.onAbort = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.#queue.push(item);
      void this.#processQueue();
    });
  }

  /**
   * Run a task protected by the request gate.
   * Acquires a permit, executes task, and guarantees permit release.
   */
  async run<T>(
    task: (signal?: AbortSignal) => Promise<T>,
    options?: { signal?: AbortSignal }
  ): Promise<T> {
    const permit = await this.acquire(options);
    try {
      return await task(options?.signal);
    } finally {
      permit.release();
    }
  }

  #removeFromQueue(id: number): void {
    const idx = this.#queue.findIndex((item) => item.id === id);
    if (idx !== -1) {
      const [removed] = this.#queue.splice(idx, 1);
      if (removed?.signal && removed.onAbort) {
        removed.signal.removeEventListener('abort', removed.onAbort);
      }
    }
  }

  async #processQueue(): Promise<void> {
    if (this.#processing) return;
    this.#processing = true;

    try {
      while (this.#queue.length > 0 && this.#activeCount < this.maxConcurrent) {
        const item = this.#queue.shift();
        if (!item) break;

        // Clean up abort listener from queue wait
        if (item.signal && item.onAbort) {
          item.signal.removeEventListener('abort', item.onAbort);
        }

        if (item.signal?.aborted) {
          item.reject(
            item.signal.reason ?? new Error('Request aborted while waiting in request gate queue')
          );
          continue;
        }

        // Calculate pacing delay needed since the start of the previous request
        const currentTime = this.#now();
        const elapsedSinceLastStart =
          this.#lastRequestStartTime !== null ? currentTime - this.#lastRequestStartTime : Infinity;
        const spacingNeeded = Math.max(0, this.minSpacingMs - elapsedSinceLastStart);

        if (spacingNeeded > 0) {
          try {
            await this.#delay(spacingNeeded, item.signal);
          } catch (delayErr) {
            item.reject(delayErr);
            continue;
          }
        }

        // Grant permit
        const startTime = this.#now();
        this.#lastRequestStartTime = startTime;
        this.#historyStartTimes.push(startTime);
        this.#activeCount++;

        let released = false;
        const permit: GatePermit = {
          release: () => {
            if (!released) {
              released = true;
              this.#activeCount = Math.max(0, this.#activeCount - 1);
              void this.#processQueue();
            }
          }
        };

        item.resolve(permit);
      }
    } finally {
      this.#processing = false;
    }
  }
}

let sharedApplicationRequestGate: WakaTimeRequestGate | undefined;

/**
 * Returns the process-wide shared application request gate enforcing:
 * - Strictly 1 concurrent in-flight upstream request.
 * - At least MIN_UPSTREAM_REQUEST_SPACING_MS (1000ms) between request starts.
 */
export function getApplicationRequestGate(): WakaTimeRequestGate {
  if (!sharedApplicationRequestGate) {
    sharedApplicationRequestGate = new WakaTimeRequestGate({
      minSpacingMs: MIN_UPSTREAM_REQUEST_SPACING_MS,
      maxConcurrent: MAX_CONCURRENT_UPSTREAM_REQUESTS
    });
  }
  return sharedApplicationRequestGate;
}

/**
 * Resets or overrides the shared application request gate (used for testing).
 */
export function resetApplicationRequestGate(gate?: WakaTimeRequestGate): void {
  sharedApplicationRequestGate = gate;
}

