import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { walletService, withdrawalService, referralService, WALLET_CONFIG } from "@clipfast/shared";
import { WithdrawForm } from "@/components/payouts/withdraw-form";

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATUS_LABEL: Record<string, string> = {
  PENDING: "Pending", APPROVED: "Approved", PAID: "Paid", REJECTED: "Rejected",
};

export default async function PayoutsPage() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect("/login");

  const [balance, active, history, referralStats] = await Promise.all([
    walletService.getWalletBalance(userId),
    withdrawalService.getActiveWithdrawal(userId),
    withdrawalService.getWithdrawalHistory(userId),
    referralService.getReferralStats(userId),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Payouts</h1>
        <p className="text-sm text-muted-foreground">Withdraw your earnings from across ClipClap.</p>
      </div>

      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Balance</h2>
        <div className="rounded-lg border border-border p-5">
          <div className="text-sm text-muted-foreground">Available to withdraw</div>
          <div className="mt-1 text-3xl font-bold tabular-nums">
            {money(Math.max(0, balance.availableUsd))}
          </div>
          {balance.availableUsd < 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              Your balance is under review following a refund or chargeback.
            </p>
          )}
          <div className="mt-5 grid grid-cols-3 gap-4 border-t border-border pt-4">
            <div>
              <div className="text-xs text-muted-foreground">Clearing</div>
              <div className="mt-0.5 text-sm tabular-nums">{money(referralStats.pendingUsd)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">In withdrawal</div>
              <div className="mt-0.5 text-sm tabular-nums">{money(balance.lockedUsd)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Paid out</div>
              <div className="mt-0.5 text-sm tabular-nums">{money(balance.paidOutUsd)}</div>
            </div>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Clearing = referral commissions still in a 14-day hold. Earned from referrals:{" "}
            {money(referralStats.earnedUsd)}.
          </p>
        </div>
      </div>

      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Withdraw</h2>
        {active ? (
          <div className="rounded-lg border border-border p-4 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Active request</span>
              <span>{STATUS_LABEL[active.status] ?? active.status}</span>
            </div>
            <div className="mt-2 tabular-nums">{money(active.amountUsd)} - {active.method}</div>
            <p className="mt-1 text-xs text-muted-foreground">
              One withdrawal at a time. You can request another once this is paid or rejected.
            </p>
          </div>
        ) : (
          <WithdrawForm availableUsd={balance.availableUsd} minUsd={WALLET_CONFIG.minWithdrawalUsd} />
        )}
      </div>

      <div className="space-y-4">
        <h2 className="text-lg font-semibold">History</h2>
        {history.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No withdrawals yet.
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Date</th>
                  <th className="px-4 py-2.5 font-medium">Amount</th>
                  <th className="px-4 py-2.5 font-medium">Method</th>
                  <th className="px-4 py-2.5 text-right font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {history.map((w) => (
                  <tr key={w.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3 text-muted-foreground">{w.createdAt.toISOString().slice(0, 10)}</td>
                    <td className="px-4 py-3 tabular-nums">
                      {money(w.amountUsd)}
                      {w.netAmountUsd != null && w.netAmountUsd !== w.amountUsd && (
                        <span className="text-muted-foreground"> (net {money(w.netAmountUsd)})</span>
                      )}
                    </td>
                    <td className="px-4 py-3">{w.method}</td>
                    <td className="px-4 py-3 text-right text-muted-foreground">{STATUS_LABEL[w.status] ?? w.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
