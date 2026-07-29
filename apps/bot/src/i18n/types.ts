import type { JobErrorCode, SubscriptionPhase } from "@clipclap/shared";

export interface Dict {
  welcomeNew: string;
  welcomeFirstChoice: string;
  welcomeBack: string;
  welcomeNeedsPlan: string;
  /**
   * Appended to the onboarding screens while the month's global free budget is
   * closed - and only then.
   *
   * The onboarding promises "your first video is free" to everyone who types
   * /start. When FREE_TIER_MONTHLY_BUDGET_USD is unset or spent, the very next
   * thing that happens to the person who believes it is freeBudgetClosed, and a
   * bot that promises then refuses inside two messages has spent the only trust
   * it was given. This note is the smallest thing that stops the contradiction:
   * the promise stays true (the minutes ARE on the account), and this says when
   * they can be spent.
   *
   * It must therefore agree with freeBudgetClosed and not merely echo it: same
   * fact - the ceiling is ours, not yours - said before the user has uploaded
   * anything rather than after. A plain string, appended by the handler, so the
   * four onboarding messages keep their own words in every locale and only one
   * sentence had to be translated six times.
   */
  freeRunsPausedNote: string;
  newAccountBtn: string;
  linkAccountBtn: string;
  newAccountCreated: string;
  linkAccountInstructions: (code: string, url: string) => string;
  callbackAck: string;
  linkCodePrompt: (code: string, url: string) => string;
  linkSuccess: (mergedClips: number) => string;
  linkAlready: string;
  linkInvalid: string;
  linkExpired: string;
  linkConflict: string;
  linkWrongDirection: string;
  sendVideoHint: string;
  uploading: string;
  queued: string;
  fileTooLarge: (url: string) => string;
  /** Takes the code parsed out of Job.error, NEVER the raw message: the stored
   *  text is engineer prose in English and must not reach a user. Unknown or
   *  untagged (null) falls back to the generic line. */
  processingFailed: (code: JobErrorCode | null) => string;
  done: (n: number) => string;
  donePartial: (sent: number, total: number) => string;
  /** The delivery row has spent its attempt budget and has just been retired,
   *  so this is the LAST thing this job will ever say in the chat - see
   *  deliverReadyTelegramJobs. `clips` is what actually exists (0 on the
   *  failure-notice path), because the copy may not claim clips the user does
   *  not have, and it may not offer a retry the terminal row cannot make. */
  deliveryGivenUp: (url: string, clips: number) => string;
  doneNoClips: (reason: string) => string;
  lowQualityNote: string;
  blocked: (reason: string) => string;
  /** The free allowance is spent. Must state what is LEFT and what a plan
   *  gives - "subscription required" tells a user nothing they can act on.
   *  Minutes, not seconds, and `remainingMinutes` is floored, so it is
   *  honestly 0 for anyone with less than a minute left. */
  freeExhausted: (
    remainingMinutes: number,
    lifetimeMinutes: number,
    planMinutes: number,
    planPriceEur: number
  ) => string;
  /** Nothing has vouched for this account yet, so it has no allowance at all.
   *  Unreachable from Telegram in practice - a bot account is anchored by its
   *  phone-backed telegramId - but the code is part of the shared union, and a
   *  refusal nobody wrote words for is a refusal in English. */
  freeNotAnchored: (planMinutes: number, planPriceEur: number) => string;
  /** Nothing is wrong with THIS account: the month's global free budget is
   *  spent, so free runs are paused until it resets. Say whose limit it is,
   *  or the user reads it as their own allowance being gone. */
  freeBudgetClosed: (planMinutes: number, planPriceEur: number) => string;
  /** Source is longer than the free run allows. Names both caps so the choice
   *  - trim it, or pay for length - is visible. */
  freeSourceTooLong: (freeMaxMinutes: number, planMaxMinutes: number) => string;
  /* ---- Refusals on a paid plan ------------------------------------------
   * Everything below used to be an English sentence built inline in
   * handlers.ts, or the raw `reason` that canSubmitJob writes for logs and
   * for the web UI. Both reached Telegram untranslated. They are rendered
   * from a block code now, so each one says the same thing in every language.
   * Every one of them names the number it refused on: a refusal the user
   * cannot act on is only a wall. */
  /** Source longer than the plan's hard cap. */
  planSourceTooLong: (maxMinutes: number) => string;
  /** Lifecycle: has a plan on the account but no subscription behind it. */
  planNotActive: string;
  /** Lifecycle: subscription canceled (with or without grace left). */
  planCanceled: string;
  /** Lifecycle: the paid period ran out. Different from canceled - nothing
   *  was refused by the user, so the copy asks for a renewal, not a return. */
  planPeriodEnded: string;
  /** The period's minutes are spent. Top-up is mentioned only when some is
   *  left, so the message never advertises a balance of zero. */
  planQuotaExceeded: (
    usedMinutes: number,
    limitMinutes: number,
    topUpMinutes: number
  ) => string;
  /** The per-day job cap. Anti-abuse, and it resets - say so. */
  planDailyLimit: (limit: number) => string;
  /** Already processing. The user has to do nothing except wait, which is
   *  the whole point of saying it in a language they read. */
  planConcurrentLimit: (active: number, limit: number) => string;
  /** Takes the option list from langOptionsList() so the sentence around it is
   *  translated but the languages in it are never hand-maintained. */
  langUsage: (options: string) => string;
  /** Confirmation of a switch TO this locale, therefore written in it. Read as
   *  `t(choice).langSet`, never off the dictionary the user was reading a
   *  moment ago - the whole point is that the next thing they see is already
   *  in the language they picked. */
  langSet: string;
  /** This language's name in itself, for the picker and the /lang usage line. */
  langName: string;
  /** Flag + langName, for the inline button. Identical in every dictionary by
   *  design: a language picker that translates its own entries is a picker the
   *  user cannot read their way out of. */
  langBtn: string;
  planStarterWeeklyBtn: string;
  planStarterBtn: string;
  planPlusBtn: string;
  planMaxBtn: string;
  menuAccount: string;
  menuHelp: string;
  menuSettings: string;
  menuAffiliate: string;
  menuPlans: string;
  plansText: string;
  plansSubscribed: (plan: string, periodEnd: string | null) => string;
  noPlanNudge: string;
  helpText: (url: string) => string;
  helpMenuPrompt: string;
  helpHowBtn: string;
  helpSupportBtn: string;
  supportPrompt: string;
  supportCloseBtn: string;
  supportClosed: string;
  supportReplyPrefix: string;
  supportUnavailable: string;
  supportVideoInSession: string;
  supportMediaUnsupported: string;
  accountText: (params: {
    plan: string;
    /** Already localized by the caller from `cycleWeekly`/`cycleMonthly` - the
     *  raw enum never gets this far. Each dictionary used to map the cycle
     *  itself, and the English one simply interpolated the raw lowercased
     *  value, so "STARTER (weekly)" was one copy-paste away from appearing
     *  inside any new language's account screen. */
    billingCycleLabel: string | null;
    periodEnd: string | null;
    daysUntilPeriodEnd: number | null;
    phase?: SubscriptionPhase;
    minutesUsed: number;
    minutesLimit: number;
    topUpMinutes: number;
    clipsStored: number;
    storageClipsLimit: number;
    retentionDays: number;
    clipsTotal: number;
  }) => string;
  planNone: string;
  settingsMenuPrompt: string;
  settingsLangBtn: string;
  settingsVideoBtn: string;
  settingsBackBtn: string;
  langMenuPrompt: string;
  videoSettingsPrompt: string;
  subtitlesToggleBtn: (enabled: boolean) => string;
  subtitlesAck: (enabled: boolean) => string;
  menuHint: string;
  botDescription: string;
  botShortDescription: string;
  commands: Array<{ command: string; description: string }>;
  manageSubscriptionBtn: string;
  checkingLink: string;
  urlAccessFailed: string;
  referralInfo: (web: string, tg: string, earned: string, pending: string) => string;
  referralWithdrawBtn: string;
  referralWithdrawStub: string;
  balanceInfo: (available: string, clearing: string) => string;
  payBtn: string;
  checkoutReady: (plan: string) => string;
  checkoutError: string;
  cycleWeekly: string;
  cycleMonthly: string;
}
