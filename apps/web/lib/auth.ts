import NextAuth, { customFetch } from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import {
  prisma,
  canonicalizeEmail,
  TELEGRAM_AUTH_PROVIDER,
  telegramAuthService,
} from "@clipclap/shared";
import { Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";
import {
  createTelegramProvider,
  getTelegramProfileId,
  telegramDiscoveryFetch,
  type TelegramOidcProfile,
} from "./telegram-provider";

const telegramClientId = process.env.TELEGRAM_CLIENT_ID;
const telegramClientSecret = process.env.TELEGRAM_CLIENT_SECRET;

// Telegram's OIDC discovery omits `userinfo_endpoint`; @auth/core rejects that
// before it ever reads the id_token. Patch the discovery response via customFetch
// (see telegramDiscoveryFetch). The symbol must be the one from next-auth so it
// matches the instance @auth/core reads off the provider config.
const telegramProviders =
  telegramClientId && telegramClientSecret
    ? [
        Object.assign(
          createTelegramProvider({
            clientId: telegramClientId,
            clientSecret: telegramClientSecret,
          }),
          { [customFetch]: telegramDiscoveryFetch }
        ),
      ]
    : [];

const nextAuth = NextAuth({
  adapter: PrismaAdapter(prisma),
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
    ...telegramProviders,
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        // Lowercase to match /api/register, which normalizes before storing.
        // The unique index is case-sensitive in Postgres, so without this an
        // address typed with different capitalisation than it was registered
        // with simply fails to log in.
        const email = (credentials.email as string).trim().toLowerCase();
        const password = credentials.password as string;

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user || !user.password) return null;

        const isValid = await bcrypt.compare(password, user.password);
        if (!isValid) return null;

        return { id: user.id, email: user.email, name: user.name, image: user.image };
      },
    }),
  ],
  session: {
    strategy: "jwt",
  },
  pages: {
    signIn: "/login",
  },
  callbacks: {
    async signIn({ account, profile }) {
      if (account?.provider === TELEGRAM_AUTH_PROVIDER && profile) {
        const telegramId = getTelegramProfileId(profile as TelegramOidcProfile);
        await telegramAuthService.ensureTelegramAuthAccount(telegramId);
      }

      return true;
    },
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user && token.id) {
        session.user.id = token.id as string;
      }
      return session;
    },
  },
  events: {
    async signIn({ user, account, profile }) {
      await syncTelegramIdentity(user.id, account, profile);
    },
    async linkAccount({ user, account, profile }) {
      await syncTelegramIdentity(user.id, account, profile);
    },
    async createUser({ user }) {
      // PrismaAdapter creates OAuth users without emailCanonical, so without
      // this every new Google signup leaves its mailbox identity unclaimed and
      // the same person can register a plus-alias by password for a second
      // free allowance. A P2002 here means the mailbox is ALREADY claimed by
      // another account - leave the column NULL and let the trial gate refuse
      // the allowance, rather than failing a sign-in the user cannot fix.
      //
      // Its own try/catch lives inside the helper, so the two jobs this hook
      // does cannot cost each other: an unclaimable mailbox must not swallow a
      // referral attribution, and a missing referral cookie must not leave a
      // mailbox unclaimed.
      await claimMailboxIdentity(user.id, user.email);

      try {
        const { cookies } = await import("next/headers");
        const { referralService, REFERRAL_COOKIE_NAME } = await import("@clipclap/shared");
        const code = (await cookies()).get(REFERRAL_COOKIE_NAME)?.value;
        if (code && user.id) {
          await referralService.attachReferral(user.id, code);
        }
      } catch (err) {
        console.error("[referral] attach on createUser failed:", err);
      }
    },
  },
});

export const handlers: typeof nextAuth.handlers = nextAuth.handlers;
export const auth: typeof nextAuth.auth = nextAuth.auth;
export const signIn: typeof nextAuth.signIn = nextAuth.signIn;
export const signOut: typeof nextAuth.signOut = nextAuth.signOut;

/**
 * Claims the mailbox behind an OAuth signup, so `emailCanonical` means the same
 * thing however the account was created.
 *
 * Exported only so it can be exercised directly against the database - a live
 * Google sign-in is not something this repo can stage in a test. Nothing but
 * `events.createUser` should call it in app code. Never throws: it runs inside
 * a sign-in, and no identity bookkeeping is worth failing a login over.
 */
export async function claimMailboxIdentity(
  userId: string | undefined,
  email: string | null | undefined
): Promise<void> {
  if (!userId || !email) return;

  const canonical = canonicalizeEmail(email);
  if (!canonical) {
    // Returning without claiming is right - there is nothing to write. But it
    // is not harmless, and it used to be invisible: the row keeps a NULL
    // emailCanonical, and isTrialAnchored refuses any account that has an email
    // without one, before it ever reaches the google branch. So a Google
    // Workspace address this function cannot canonicalise - a dotless internal
    // domain like oleg@internal is the realistic one - silently costs that user
    // their allowance for ever, with nothing in the logs to say why. The P2002
    // warning below does not cover this path.
    console.warn(
      `[identity] could not canonicalise ${email} - leaving emailCanonical null for user ${userId}; this account will not be trial-anchored`
    );
    return;
  }

  try {
    await prisma.user.update({
      where: { id: userId },
      data: { emailCanonical: canonical },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      // Warn, not error: this is a duplicate-mailbox event worth looking at by
      // hand, not a fault. The column stays NULL and the trial gate treats an
      // account that has an email but no canonical as unanchored.
      console.warn(
        `[identity] mailbox ${canonical} is already claimed by another account - leaving emailCanonical null for user ${userId}`
      );
      return;
    }
    console.error("[identity] emailCanonical claim failed:", err);
  }
}

async function syncTelegramIdentity(
  userId: string | undefined,
  account: { provider?: string; providerAccountId?: string } | null | undefined,
  profile: unknown
) {
  if (!userId || account?.provider !== TELEGRAM_AUTH_PROVIDER) return;

  const telegramId = profile
    ? getTelegramProfileId(profile as TelegramOidcProfile)
    : account.providerAccountId;

  if (!telegramId) return;

  await telegramAuthService.syncUserTelegramId(userId, telegramId);
}
