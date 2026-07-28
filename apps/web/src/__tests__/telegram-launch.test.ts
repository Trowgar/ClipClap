import { describe, expect, it } from "vitest";
import { initDataFromLaunchHash, isTelegramLaunch } from "../../lib/telegram-launch";

const INIT_DATA =
  'query_id=AAHdF6IQAAAAAN0XohDhrOrc&user={"id":575308044,"first_name":"Oleg"}&auth_date=1753639200&hash=abc123';

function launchHash(initData: string, extra = ""): string {
  return `#tgWebAppData=${encodeURIComponent(initData)}&tgWebAppVersion=7.0&tgWebAppPlatform=ios${extra}`;
}

describe("initDataFromLaunchHash", () => {
  it("returns the initData query string byte-for-byte", () => {
    expect(initDataFromLaunchHash(launchHash(INIT_DATA))).toBe(INIT_DATA);
  });

  it("preserves a literal + instead of decoding it to a space", () => {
    // encodeURIComponent leaves `+` alone, so it reaches us raw. URLSearchParams
    // would turn it into a space here and break the signature.
    const withPlus = 'user={"id":1,"first_name":"A+B"}&auth_date=1&hash=ff';
    expect(initDataFromLaunchHash(launchHash(withPlus))).toBe(withPlus);
  });

  it("finds the parameter wherever it sits in the fragment", () => {
    const hash = `#tgWebAppVersion=7.0&tgWebAppData=${encodeURIComponent(INIT_DATA)}`;
    expect(initDataFromLaunchHash(hash)).toBe(INIT_DATA);
  });

  it("accepts a fragment with no leading #", () => {
    expect(initDataFromLaunchHash(launchHash(INIT_DATA).slice(1))).toBe(INIT_DATA);
  });

  it("returns empty for a plain browser visit", () => {
    expect(initDataFromLaunchHash("")).toBe("");
    expect(initDataFromLaunchHash("#")).toBe("");
    expect(initDataFromLaunchHash("#surface=bot")).toBe("");
  });

  it("does not match a parameter that merely ends in tgWebAppData", () => {
    expect(initDataFromLaunchHash("#nottgWebAppData=x")).toBe("");
  });

  it("returns empty rather than throwing on a malformed escape", () => {
    expect(initDataFromLaunchHash("#tgWebAppData=%E0%A4%A")).toBe("");
  });
});

describe("isTelegramLaunch", () => {
  it("recognises a re-open that carries no signed data", () => {
    // Exactly what a real iPhone sent us: decoration, no tgWebAppData.
    const reopen =
      "#tgWebAppVersion=7.0&tgWebAppPlatform=ios&tgWebAppThemeParams=%7B%7D";
    expect(isTelegramLaunch(reopen)).toBe(true);
    expect(initDataFromLaunchHash(reopen)).toBe("");
  });

  it("recognises a first launch", () => {
    expect(isTelegramLaunch(launchHash(INIT_DATA))).toBe(true);
  });

  it("is false for a plain browser visit", () => {
    expect(isTelegramLaunch("")).toBe(false);
    expect(isTelegramLaunch("#")).toBe(false);
    expect(isTelegramLaunch("#section=funnel")).toBe(false);
  });

  it("is not fooled by a parameter that merely contains the prefix", () => {
    expect(isTelegramLaunch("#nottgWebAppVersion=7.0")).toBe(false);
  });
});
