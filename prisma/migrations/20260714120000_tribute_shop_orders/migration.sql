CREATE TYPE "TributeOrderStatus" AS ENUM ('PENDING', 'PAID', 'DUNNING', 'CANCELLED', 'FAILED');

CREATE TABLE "tribute_orders" (
    "id" TEXT NOT NULL,
    "orderUuid" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "plan" "Plan" NOT NULL,
    "billingCycle" "BillingCycle" NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "payUrl" TEXT NOT NULL,
    "status" "TributeOrderStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tribute_orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tribute_orders_orderUuid_key" ON "tribute_orders"("orderUuid");
CREATE INDEX "tribute_orders_userId_idx" ON "tribute_orders"("userId");
CREATE INDEX "tribute_orders_userId_plan_billingCycle_status_idx" ON "tribute_orders"("userId", "plan", "billingCycle", "status");

ALTER TABLE "tribute_orders" ADD CONSTRAINT "tribute_orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
