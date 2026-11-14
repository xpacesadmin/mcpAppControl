'use strict';

class SlidingWindowRateLimiter {
  constructor(clock = () => Date.now()) {
    this.clock = clock;
    this.entries = new Map();
  }

  consume(key, limit, windowMs) {
    const now = this.clock();
    const cutoff = now - windowMs;
    const existing = (this.entries.get(key) || []).filter(timestamp => timestamp > cutoff);
    if (existing.length >= limit) {
      const retryAfterMs = Math.max(1, existing[0] + windowMs - now);
      this.entries.set(key, existing);
      return { allowed: false, remaining: 0, retryAfterMs };
    }
    existing.push(now);
    this.entries.set(key, existing);
    return { allowed: true, remaining: Math.max(0, limit - existing.length), retryAfterMs: 0 };
  }

  prune() {
    const now = this.clock();
    for (const [key, timestamps] of this.entries) {
      const active = timestamps.filter(timestamp => timestamp > now - 24 * 60 * 60 * 1000);
      if (active.length) this.entries.set(key, active);
      else this.entries.delete(key);
    }
  }
}

module.exports = { SlidingWindowRateLimiter };

