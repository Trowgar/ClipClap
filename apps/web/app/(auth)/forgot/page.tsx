import type { Metadata } from "next";
import { AuthCard, AuthShell } from "@/components/auth-shell";
import { ForgotForm } from "./forgot-form";

export const metadata: Metadata = {
  title: "Reset your password - ClipClap",
  // A reset flow has no business being indexed, and neither has the link a
  // search engine might follow off it.
  robots: { index: false, follow: false },
};

/** Signed out on purpose - no `auth()` call and no middleware match. The one
 *  person who needs this page is the one who cannot get a session. */
export default async function ForgotPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  // Only ever what the sign-in form put here, which is what the user typed one
  // screen earlier. Echoing their own input back discloses nothing.
  const raw = params.email;
  const initialEmail = typeof raw === "string" ? raw.slice(0, 254) : "";

  return (
    <AuthShell>
      <AuthCard>
        <ForgotForm initialEmail={initialEmail} />
      </AuthCard>
    </AuthShell>
  );
}
