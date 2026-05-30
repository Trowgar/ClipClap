// Days of access granted past currentPeriodEnd before the runtime guard blocks
// and the reconcile cron date-expires a subscription. Covers webhook delivery
// lag and Stripe Smart Retries (first reattempt is ~day 3).
export const SUBSCRIPTION_GRACE_BUFFER_DAYS = 3;
