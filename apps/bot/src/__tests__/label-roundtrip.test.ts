import { describe, expect, it } from "vitest";
import { LOCALES, t } from "../i18n";
import {
  matchMenuAction, matchSettingsAction, matchEarnAction,
  matchReferralAction, matchHelpAction, matchSupportAction,
} from "../handlers";

/** Every reply-keyboard label must be matched by its own matcher, in every
 *  locale. The existing "no keyboard label meaning two different things"
 *  assertion checks for COLLISIONS between locales; this one checks that a
 *  label routes at all.
 *
 *  Those are different failures. A label can be unique and still fail to
 *  match - an invisible bidi control character inside it, a trailing space, a
 *  different emoji variant selector - and the symptom is a button that does
 *  nothing, with no error anywhere. That failure mode is why Arabic copy is
 *  forbidden from using isolate() in labels, and this is the guard that would
 *  notice if it crept back in by another route. */
describe("every label routes to its own action, in every locale", () => {
  for (const loc of LOCALES) {
    const d = t(loc);
    it(`${loc}`, () => {
      expect(matchMenuAction(d.menuCreate)).toBe("create");
      expect(matchMenuAction(d.menuAccount)).toBe("account");
      expect(matchMenuAction(d.menuHelp)).toBe("help");
      expect(matchMenuAction(d.menuSettings)).toBe("settings");
      expect(matchMenuAction(d.menuEarn)).toBe("earn");
      expect(matchMenuAction(d.menuPlans)).toBe("plans");
      expect(matchSettingsAction(d.settingsLangBtn)).toBe("lang");
      expect(matchSettingsAction(d.settingsVideoBtn)).toBe("video");
      expect(matchSettingsAction(d.settingsLinkBtn)).toBe("link");
      expect(matchSettingsAction(d.settingsBackBtn)).toBe("menu");
      expect(matchEarnAction(d.earnReferralBtn)).toBe("referral");
      expect(matchEarnAction(d.earnAdvertisersBtn)).toBe("advertisers");
      expect(matchReferralAction(d.referralWithdrawBtn)).toBe("withdraw");
      expect(matchHelpAction(d.helpHowBtn)).toBe("how");
      expect(matchHelpAction(d.helpSupportBtn)).toBe("support");
      expect(matchSupportAction(d.supportCloseBtn)).toBe("close");
    });
  }
});
