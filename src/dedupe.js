const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX = 500;

/**
 * In-memory delivery-id cache for webhook idempotency.
 */
export function createDeliveryCache({ ttlMs = DEFAULT_TTL_MS, max = DEFAULT_MAX } = {}) {
  const seen = new Map();

  function prune(now = Date.now()) {
    for (const [id, expiresAt] of seen) {
      if (expiresAt <= now) {
        seen.delete(id);
      }
    }
    while (seen.size > max) {
      const oldest = seen.keys().next().value;
      seen.delete(oldest);
    }
  }

  return {
    /**
     * @returns {boolean} true if this delivery was already seen
     */
    has(deliveryId) {
      if (!deliveryId) return false;
      prune();
      const expiresAt = seen.get(deliveryId);
      if (!expiresAt) return false;
      if (expiresAt <= Date.now()) {
        seen.delete(deliveryId);
        return false;
      }
      return true;
    },
    remember(deliveryId) {
      if (!deliveryId) return;
      prune();
      seen.set(deliveryId, Date.now() + ttlMs);
      prune();
    },
  };
}
