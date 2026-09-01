/** BullMQ reserves ':' for its Redis key namespace and rejects it in names. */
export function qualityCanaryQueueName(primaryQueueName: string): string {
  return `${primaryQueueName}-quality-canary`;
}
