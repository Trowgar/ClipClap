import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { billingService } from "@clipfast/shared";
import { ManageBillingButton } from "@/components/manage-billing-button";
import { InvoiceTable } from "@/components/invoice-table";

export default async function BillingPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const page = await billingService.listInvoices(session.user.id);

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Billing</h1>
        <p className="text-sm text-muted-foreground">
          View your invoices and manage payment methods.
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Payment & subscription</h2>
          <ManageBillingButton />
        </div>
        <p className="text-sm text-muted-foreground">
          Update your payment method, change plan, or cancel your subscription
          via the Stripe Customer Portal.
        </p>
      </div>

      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Invoice history</h2>
        <InvoiceTable
          initialInvoices={page.invoices}
          initialCursor={page.nextCursor}
        />
      </div>
    </div>
  );
}
