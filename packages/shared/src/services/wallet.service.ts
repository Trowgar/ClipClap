import { prisma } from "../lib/prisma";
import type { Prisma, PrismaClient, WalletEntryKind, WalletSource } from "@prisma/client";

/** Prisma client or an interactive-transaction client. */
type Db = PrismaClient | Prisma.TransactionClient;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface WalletBalance {
  ledgerBalanceUsd: number;
  lockedUsd: number;
  availableUsd: number;
  paidOutUsd: number;
}

export async function getWalletBalance(userId: string): Promise<WalletBalance> {
  const [credit, debit, withdrawn, locked] = await Promise.all([
    prisma.walletEntry.aggregate({ _sum: { amountUsd: true }, where: { userId, kind: "CREDIT" } }),
    prisma.walletEntry.aggregate({ _sum: { amountUsd: true }, where: { userId, kind: "DEBIT" } }),
    prisma.walletEntry.aggregate({ _sum: { amountUsd: true }, where: { userId, source: "WITHDRAWAL" } }),
    prisma.withdrawalRequest.aggregate({
      _sum: { amountUsd: true },
      where: { userId, status: { in: ["PENDING", "APPROVED"] } },
    }),
  ]);
  const ledgerBalanceUsd = round2((credit._sum.amountUsd ?? 0) - (debit._sum.amountUsd ?? 0));
  const lockedUsd = round2(locked._sum.amountUsd ?? 0);
  return {
    ledgerBalanceUsd,
    lockedUsd,
    availableUsd: round2(ledgerBalanceUsd - lockedUsd),
    paidOutUsd: round2(withdrawn._sum.amountUsd ?? 0),
  };
}

/** Credits earned per source (CREDIT only). Missing sources -> 0. */
export async function getEarningsBySource(userId: string): Promise<Record<string, number>> {
  const groups = await prisma.walletEntry.groupBy({
    by: ["source"],
    where: { userId, kind: "CREDIT" },
    _sum: { amountUsd: true },
  });
  const out: Record<string, number> = {};
  for (const g of groups) out[g.source] = round2(g._sum.amountUsd ?? 0);
  return out;
}

export interface PostWalletEntryInput {
  userId: string;
  kind: WalletEntryKind;
  source: WalletSource;
  refType: string;
  refId: string;
  amountUsd: number;
  memo?: string;
}

/**
 * Append a money-ledger row. Idempotent on the (source, refType, refId) unique
 * key: a duplicate (P2002) is a no-op. Pass a transaction client when posting
 * inside a larger transaction (referral release / withdrawal payment).
 */
export async function postWalletEntry(client: Db | undefined, input: PostWalletEntryInput): Promise<void> {
  const db = client ?? prisma;
  try {
    await db.walletEntry.create({
      data: {
        userId: input.userId,
        kind: input.kind,
        source: input.source,
        refType: input.refType,
        refId: input.refId,
        amountUsd: input.amountUsd,
        memo: input.memo,
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return; // already posted
    throw err;
  }
}
