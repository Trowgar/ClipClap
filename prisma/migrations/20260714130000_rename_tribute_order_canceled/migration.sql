-- Align TributeOrderStatus with the codebase spelling (SubscriptionStatus.CANCELED).
ALTER TYPE "TributeOrderStatus" RENAME VALUE 'CANCELLED' TO 'CANCELED';
