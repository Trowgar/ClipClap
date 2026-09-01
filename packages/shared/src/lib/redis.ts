import IORedis from "ioredis";

let redis: IORedis | null = null;

export function getRedis(): IORedis {
  if (!redis) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL environment variable is required");
    redis = new IORedis(url, { maxRetriesPerRequest: null });
  }
  return redis;
}

/**
 * Short-lived Redis connection for safety-critical quality-gate control work.
 *
 * Workers need the shared client's unlimited request retries to survive normal
 * background processing. Deploy fencing must instead fail closed: no control
 * operation may wait indefinitely for a reconnect or a queued command.
 */
export function createQualityRedis(): IORedis {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL environment variable is required");
  return new IORedis(url, {
    connectTimeout: 5_000,
    commandTimeout: 5_000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
}
