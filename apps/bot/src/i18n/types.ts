import type { JobErrorCode, SubscriptionPhase } from "@clipclap/shared";

export interface Dict {
  /**
   * What a stranger sees on their very first /start - and the only thing they
   * see. It replaced a screen that asked "New account or do you already have
   * one?" before delivering anything at all.
   *
   * That question was about our account topology, not about the user's goal, it
   * was put to 100% of arrivals to serve the sliver who own a clipclap.io
   * account AND found the bot on their own AND want the two joined - and the
   * main path for that sliver is the website's deep link, which skips this
   * screen entirely. Linking now lives on `settingsLinkBtn` and /link.
   *
   * No account is created by this screen. resolveTelegramUser is still the only
   * door to a User row and it is still reached lazily - on the first video, or
   * on a settings change - so a stranger who reads this and leaves leaves no
   * row behind, and `signed_up` keeps meaning "someone who did something".
   */
  welcomeFirstScreen: string;
  /** A greeting, and therefore only for /start - somebody who has arrived.
   *
   *  It used to double as the text for "you are back at the main menu", which
   *  greeted people who had never left: tapping Settings and then ⬅️ Menu
   *  answered "Welcome back!". Navigation gets `menuTitle` instead. */
  welcomeBack: string;
  /** The main menu reached by navigation - /menu, or ⬅️ Menu out of a submenu.
   *
   *  A bare label on purpose. A reply keyboard has to be attached to some
   *  message, so something must be said, but the keyboard IS the content and its
   *  first full-width button is the primary action. Telling the reader to press
   *  the button they are looking at is the same wasted line as the "Tap START to
   *  begin" that came off botDescription. */
  menuTitle: string;
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
  /* The live progress board.
   *
   * Words only - the ✅/⏳/◽ markers and the line order are layout and live in
   * renderProgressBoard, so the six dictionaries cannot disagree about the shape
   * of the thing or drift a step out of sequence.
   *
   * Stage names are the user's mental model, not ours: "Listening to the speech"
   * rather than TRANSCRIBE, "Finding the best moments" rather than ANALYZE. The
   * pipeline's own names are engineer vocabulary and mean nothing to a clipper.
   *
   * No ETA anywhere, deliberately. Measured over production jobs, the same
   * 30-minute source finished in 153 s once and 780 s another time - a fivefold
   * spread - so time remaining is not derivable from anything we know at submit,
   * and a wrong "about 5 minutes" is worse than no estimate at all. */
  progressTitle: string;
  progressQueuedNote: string;
  progressStepDownload: string;
  progressStepTranscribe: string;
  progressStepAnalyze: string;
  progressStepRender: string;
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
  /** The per-user submit lock was held too long and we gave up waiting.
   *
   *  Deliberately NOT planConcurrentLimit: that one states a plan limit and
   *  quotes numbers, and this is neither a limit nor the user's fault - it is
   *  contention, and the only true instruction is to try again. Reusing the
   *  concurrency copy would tell someone their plan refused them when it did
   *  not. It replaces an uncaught error that reached the user as silence. */
  submitBusy: string;
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
  /** The primary action, and the reason it exists: the main keyboard used to
   *  carry five buttons - Plans, Account, Affiliate, Help, Settings - and not
   *  one of them was "make a clip". A new arrival was shown the till and the
   *  help desk and nothing about the product. */
  menuCreate: string;
  /** Answer to menuCreate, and the home of every technical limit.
   *
   *  The numbers live here rather than on the pre-START description because
   *  this is the moment they are useful - the user is choosing a file - instead
   *  of a wall in front of a stranger. Taken as arguments so the caller reads
   *  them off the plan config: a hardcoded "3 hours" in six locales is six
   *  places to drift from ABUSE_CAPS. */
  createPrompt: (limits: {
    /** The free cap, or null for somebody who is not on the free tier.
     *
     *  Null omits the line entirely rather than printing a zero: a subscriber
     *  reading "on the free run: up to 60 minutes" is being told about an
     *  allowance that is not theirs and a limit that does not apply to them,
     *  which is noise on the one screen that exists to answer "what may I
     *  send?". */
    freeMaxMinutes: number | null;
    planMaxMinutes: number;
    maxFileGb: number;
  }) => string;
  menuAccount: string;
  menuHelp: string;
  menuSettings: string;
  /** Was `menuAffiliate`. Renamed because it now opens a submenu with two
   *  different offers under it - the referral programme and the advertiser
   *  brokerage - and "Affiliate" had stopped describing either. "Earn" is what
   *  the user is there for; the mechanism is the submenu's business. */
  menuEarn: string;
  menuPlans: string;
  earnMenuPrompt: string;
  earnReferralBtn: string;
  earnAdvertisersBtn: string;
  /** Placeholder for the advertiser brokerage, which is deliberately not built
   *  yet. It describes the offer and says it is coming, and the tap is recorded
   *  in the funnel - so whether it gets built is answered by how many people
   *  press a button, not by a guess. Promises no date, because there is none. */
  earnAdvertisersSoon: string;
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
  /** Where account linking went when the two-button first screen was removed.
   *  This is the hint, and Settings is where someone who paid on the website
   *  and then opened the bot will actually look. /link still works, and the
   *  website's deep link remains the main path. */
  settingsLinkBtn: string;
  settingsBackBtn: string;
  langMenuPrompt: string;
  videoSettingsPrompt: string;
  subtitlesToggleBtn: (enabled: boolean) => string;
  subtitlesAck: (enabled: boolean) => string;
  botDescription: string;
  botShortDescription: string;
  commands: Array<{ command: string; description: string }>;
  manageSubscriptionBtn: string;
  checkingLink: string;
  urlAccessFailed: string;
  /** Shown instead of urlAccessFailed when the refused link was a YouTube one.
   *  The generic copy leads with "try a different URL", which is the one thing
   *  that cannot work while YouTube refuses this host - see isYouTubeUrl. */
  urlYouTubeUnavailable: string;
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
