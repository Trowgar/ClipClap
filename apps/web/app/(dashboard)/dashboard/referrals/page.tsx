import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { prisma, referralService, REFERRAL_CONFIG } from "@clipfast/shared";
import { CopyField } from "@/components/referrals/copy-field";
import { JoinAffiliate } from "@/components/referrals/join-affiliate";

const RATE_PCT = REFERRAL_CONFIG.rateBps / 100;
const HOLD_DAYS = REFERRAL_CONFIG.holdDays;

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function statusLabel(status: string): { label: string; muted: boolean } {
  switch (status) {
    case "ACTIVE":
      return { label: "Active", muted: false };
    case "DUNNING":
    case "CANCELED_GRACE":
      return { label: "At risk", muted: true };
    default:
      return { label: "Inactive", muted: true };
  }
}

export default async function ReferralsPage() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect("/login");

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      referralCode: true,
      referralTermsAcceptedAt: true,
    },
  });

  // ---------- Not yet joined ----------
  if (!user?.referralTermsAcceptedAt) {
    return (
      <div className="mx-auto max-w-3xl space-y-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Affiliate Program</h1>
          <p className="text-sm text-muted-foreground">
            Earn {RATE_PCT}% of every payment from people you refer, for as long as they
            stay subscribed.
          </p>
        </div>

        <div className="space-y-4">
          <h2 className="text-lg font-semibold">How it works</h2>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li>{RATE_PCT}% commission on every payment, for life.</li>
            <li>Earnings clear after a {HOLD_DAYS}-day hold.</li>
            <li>Withdraw anytime from your Payouts page once your balance clears.</li>
          </ul>
        </div>

        <div className="space-y-3">
          <JoinAffiliate />
          <p className="text-xs text-muted-foreground">
            By joining you agree to the payout terms ({RATE_PCT}% of net payments, after
            fees) and anti-fraud rules.
          </p>
        </div>
      </div>
    );
  }

  // ---------- Joined ----------
  const code = user.referralCode ?? (await referralService.ensureReferralCode(userId));
  const stats = await referralService.getReferralStats(userId);
  const referrals = await prisma.user.findMany({
    where: { referredById: userId },
    select: { id: true, createdAt: true, plan: true, subscriptionStatus: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL ?? "https://clipclap.io";
  const botName =
    process.env.TELEGRAM_BOT_USERNAME ?? process.env.NEXT_PUBLIC_BOT_NAME ?? "ClipClapBot";
  const webLink = `${appUrl.replace(/\/$/, "")}/?ref=${code}`;
  const tgLink = `https://t.me/${botName}?start=ref_${code}`;

  const activeCount = referrals.filter((r) => r.subscriptionStatus === "ACTIVE").length;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Affiliate Program</h1>
        <p className="text-sm text-muted-foreground">
          Earn {RATE_PCT}% of every referral&apos;s payments, for life.
        </p>
      </div>

      {/* Earnings (referral) */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Referral earnings</h2>
        <div className="rounded-lg border border-border p-5">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-xs text-muted-foreground">Total earned</div>
              <div className="mt-0.5 text-2xl font-bold tabular-nums">{money(stats.earnedUsd)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Pending ({HOLD_DAYS}-day hold)</div>
              <div className="mt-0.5 text-2xl font-bold tabular-nums">{money(stats.pendingUsd)}</div>
            </div>
          </div>
          <a
            href="/dashboard/payouts"
            className="mt-4 inline-block text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Available to withdraw lives on your Payouts page -&gt;
          </a>
        </div>
      </div>

      {/* Referral link */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Your referral link</h2>
        <p className="text-sm text-muted-foreground">
          Share your code or either link. Both carry your referral.
        </p>
        <div className="space-y-2">
          <CopyField label="Code" value={code} />
          <CopyField label="Web link" value={webLink} />
          <CopyField label="Telegram link" value={tgLink} />
        </div>
      </div>

      {/* Referrals */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Referrals</h2>
          {referrals.length > 0 && (
            <span className="text-sm text-muted-foreground">
              {activeCount} active &middot; {referrals.length} total
            </span>
          )}
        </div>

        {referrals.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No referrals yet. Share your link to start earning.
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Referral</th>
                  <th className="px-4 py-2.5 font-medium">Joined</th>
                  <th className="px-4 py-2.5 font-medium">Plan</th>
                  <th className="px-4 py-2.5 text-right font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {referrals.map((r) => {
                  const s = statusLabel(r.subscriptionStatus);
                  return (
                    <tr key={r.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        #{r.id.slice(-8)}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {r.createdAt.toISOString().slice(0, 10)}
                      </td>
                      <td className="px-4 py-3">{r.plan === "NONE" ? "Free" : r.plan}</td>
                      <td
                        className={`px-4 py-3 text-right ${
                          s.muted ? "text-muted-foreground" : "text-foreground"
                        }`}
                      >
                        {s.label}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* How it works / terms */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">How it works</h2>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li>{RATE_PCT}% commission on every payment, for life.</li>
          <li>Earnings clear after a {HOLD_DAYS}-day hold.</li>
          <li>Withdraw anytime from your Payouts page once your balance clears.</li>
        </ul>
      </div>
    </div>
  );
}
