export class RegistrationRateLimiter {
  readonly #attempts = new Map<string, number[]>();

  constructor(
    private readonly limit = 10,
    private readonly windowMs = 10 * 60 * 1000
  ) {}

  allow(key: string, nowMs = Date.now()): boolean {
    const earliest = nowMs - this.windowMs;
    const recent = (this.#attempts.get(key) ?? []).filter((attempt) => attempt > earliest);
    if (recent.length >= this.limit) {
      this.#attempts.set(key, recent);
      return false;
    }
    recent.push(nowMs);
    this.#attempts.set(key, recent);
    return true;
  }

  clear(key: string): void {
    this.#attempts.delete(key);
  }

  reset(): void {
    this.#attempts.clear();
  }
}
