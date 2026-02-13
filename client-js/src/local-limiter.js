export export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class LocalLimiter {
  constructor({ globalRps = 45, routeRps = 5 } = {}) {
    this.globalRps = Math.max(1, globalRps);
    this.routeRps = Math.max(1, routeRps);
    this.nextAt = new Map();
    this.chains = new Map();
    this.lastCleanupAt = Date.now();
  }

  async acquire(routeKey, discordIdentity) {
    const globalKey = discordIdentity ? `global:${discordIdentity}` : "global";
    await this.#acquireKey(globalKey, this.globalRps);
    await this.#acquireKey(`route:${routeKey}`, this.routeRps);
  }

  async #acquireKey(key, rps) {
    const previous = this.chains.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.chains.set(key, previous.then(() => current));

    await previous;
    const intervalMs = Math.ceil(1000 / rps);
    const now = Date.now();
    const scheduled = Math.max(now, this.nextAt.get(key) ?? now);
    this.nextAt.set(key, scheduled + intervalMs);
    const waitMs = Math.max(0, scheduled - now);
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    release();
    if (this.chains.get(key) === current) {
      this.chains.delete(key);
    }

    // Periodic cleanup of stale entries in nextAt
    // Clean up entries older than 60 seconds every 30 seconds
    if (now - this.lastCleanupAt > 30000) {
      this.#cleanup(now);
      this.lastCleanupAt = now;
    }
  }

  #cleanup(now) {
    const cutoff = now - 60000; // 60 seconds ago
    for (const [key, timestamp] of this.nextAt.entries()) {
      if (timestamp < cutoff && !this.chains.has(key)) {
        this.nextAt.delete(key);
      }
    }
  }
}
