import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { WALLET_CONFIG, findWalletMethod } from "../config/wallet";
import { postWalletEntry } from "./wallet.service";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const ACTIVE = ["PENDING", "APPROVED"] as const;

export function validateWithdrawalDestination(
  method: string,
  destination: string
): { ok: boolean; error?: string } {
  const m = findWalletMethod(method);
  if (!m) return { ok: false, error: "Unsupported method" };
  return m.validate.test(destination.trim())
    ? { ok: true }
    : { ok: false, error: `Invalid ${m.label} address` };
}

export interface CreateWithdrawalInput {
  method: string;
  destination: string;
  amountUsd: number;
}

export type CreateWithdrawalResult =
  | { status: "created"; requestId: string }
  | { status: "error"; error: string };

/**
 * Run fn in a transaction holding a per-user advisory lock, so concurrent
 * withdrawals for the SAME user serialize (preventing double-spend) with zero
 * cross-user contention. Read Committed is sufficient: the second caller blocks
 * on the lock until the first commits, then sees the committed active request /
 * updated balance. The lock auto-releases on commit or rollback.
 */
async function withUserLock<T>(
  userId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // Acquire the lock inside a subquery and select a constant - pg_advisory_xact_lock
    // returns void, which $queryRaw cannot deserialize directly.
    await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtext(${userId}), 0)) AS _lock`;
    return fn(tx);
  });
}

async function ledgerBalanceInTx(tx: Prisma.TransactionClient, userId: string): Promise<number> {
  const [c, d] = await Promise.all([
    tx.walletEntry.aggregate({ _sum: { amountUsd: true }, where: { userId, kind: "CREDIT" } }),
    tx.walletEntry.aggregate({ _sum: { amountUsd: true }, where: { userId, kind: "DEBIT" } }),
  ]);
  return round2((c._sum.amountUsd ?? 0) - (d._sum.amountUsd ?? 0));
}

async function lockedInTx(tx: Prisma.TransactionClient, userId: string): Promise<number> {
  const l = await tx.withdrawalRequest.aggregate({
    _sum: { amountUsd: true },
    where: { userId, status: { in: [...ACTIVE] } },
  });
  return round2(l._sum.amountUsd ?? 0);
}

export async function createWithdrawal(
  userId: string,
  input: CreateWithdrawalInput
): Promise<CreateWithdrawalResult> {
  const v = validateWithdrawalDestination(input.method, input.destination);
  if (!v.ok) return { status: "error", error: v.error! };
  const amount = round2(input.amountUsd);

  try {
    return await withUserLock(userId, async (tx) => {
    const ledger = await ledgerBalanceInTx(tx, userId);
    const locked = await lockedInTx(tx, userId);
    const available = round2(ledger - locked);

    if (ledger <= 0 || available <= 0) return { status: "error", error: "No funds available" };
    if (amount < WALLET_CONFIG.minWithdrawalUsd)
      return { status: "error", error: `Minimum withdrawal is $${WALLET_CONFIG.minWithdrawalUsd}` };
    if (amount > available) return { status: "error", error: "Amount exceeds available balance" };

    const active = await tx.withdrawalRequest.findFirst({
      where: { userId, status: { in: [...ACTIVE] } },
      select: { id: true },
    });
    if (active) return { status: "error", error: "You already have a withdrawal in progress" };

    const created = await tx.withdrawalRequest.create({
      data: {
        userId,
        amountUsd: amount,
        method: input.method,
        destination: input.destination.trim(),
        requestedAvailableUsd: available,
        networkFeeUsd: 0,
        netAmountUsd: amount,
        status: "PENDING",
      },
      select: { id: true },
    });
    return { status: "created", requestId: created.id };
    });
  } catch (err) {
    // Serializable retries exhausted under heavy contention -> graceful error, not a thrown 500.
    if ((err as { code?: string }).code === "P2034") {
      return {
        status: "error",
        error: "Could not process the withdrawal right now, please try again.",
      };
    }
    throw err;
  }
}

export async function listPendingWithdrawals() {
  return prisma.withdrawalRequest.findMany({
    where: { status: { in: [...ACTIVE] } },
    orderBy: { createdAt: "asc" },
  });
}

export async function getActiveWithdrawal(userId: string) {
  return prisma.withdrawalRequest.findFirst({
    where: { userId, status: { in: [...ACTIVE] } },
    orderBy: { createdAt: "desc" },
  });
}

export async function getWithdrawalHistory(userId: string) {
  return prisma.withdrawalRequest.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

export async function approveWithdrawal(
  id: string,
  adminId: string,
  networkFeeUsd: number
): Promise<{ ok: boolean; error?: string }> {
  const wr = await prisma.withdrawalRequest.findUnique({ where: { id } });
  if (!wr) return { ok: false, error: "Not found" };
  if (wr.status !== "PENDING") return { ok: false, error: `Cannot approve from status ${wr.status}` };
  if (networkFeeUsd < 0 || networkFeeUsd >= wr.amountUsd)
    return { ok: false, error: "Fee must be >= 0 and < amount" };
  const net = round2(wr.amountUsd - networkFeeUsd);
  if (net <= 0) return { ok: false, error: "Net payout must be positive" };

  const ledger = await ledgerBalanceInTx(prisma as unknown as Prisma.TransactionClient, wr.userId);
  const locked = await lockedInTx(prisma as unknown as Prisma.TransactionClient, wr.userId);
  if (ledger < locked) {
    return {
      ok: false,
      error:
        `Cannot approve: balance no longer covers this withdrawal after a clawback. ` +
        `Ledger balance: $${ledger} - Locked: $${locked} - Requested: $${wr.amountUsd}`,
    };
  }

  const updated = await prisma.withdrawalRequest.updateMany({
    where: { id, status: "PENDING" },
    data: { status: "APPROVED", approvedBy: adminId, approvedAt: new Date(), networkFeeUsd, netAmountUsd: net },
  });
  if (updated.count === 0) return { ok: false, error: "State changed; retry" };
  return { ok: true };
}

export async function markWithdrawalPaid(id: string, adminId: string, txRef: string): Promise<{ ok: boolean; error?: string }> {
  return prisma.$transaction(async (tx) => {
    const wr = await tx.withdrawalRequest.findUnique({ where: { id } });
    if (!wr) return { ok: false, error: "Not found" };
    if (wr.status !== "APPROVED") return { ok: false, error: `Cannot pay from status ${wr.status}` };
    await tx.withdrawalRequest.update({
      where: { id },
      data: { status: "PAID", paidBy: adminId, paidAt: new Date(), txRef },
    });
    // Debit the GROSS amount (the network fee is borne by the user, matching the locked amount).
    await postWalletEntry(tx, {
      userId: wr.userId, kind: "DEBIT", source: "WITHDRAWAL",
      refType: "withdrawal", refId: wr.id, amountUsd: wr.amountUsd,
    });
    return { ok: true };
  });
}

export async function rejectWithdrawal(id: string, adminId: string, reason: string): Promise<{ ok: boolean; error?: string }> {
  if (!reason?.trim()) return { ok: false, error: "Reason required" };
  const updated = await prisma.withdrawalRequest.updateMany({
    where: { id, status: { in: [...ACTIVE] } },
    data: { status: "REJECTED", rejectedBy: adminId, rejectedAt: new Date(), adminNote: reason },
  });
  if (updated.count === 0) return { ok: false, error: "Not in a rejectable state" };
  return { ok: true };
}
