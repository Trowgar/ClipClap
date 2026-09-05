import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const redisSetMock = vi.hoisted(() => vi.fn());
const redisGetMock = vi.hoisted(() => vi.fn());
const redisEvalMock = vi.hoisted(() => vi.fn());
const sendTelegramMessageMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/redis", () => ({
  getRedis: () => ({ set: redisSetMock, get: redisGetMock, eval: redisEvalMock }),
}));
vi.mock("../telegram-notification.service", () => ({
  sendTelegramMessage: sendTelegramMessageMock,
}));

import {
  PIPELINE_INCIDENT_TTL_SECONDS,
  notifyPipelineIncident,
} from "../pipeline-incident-monitor.service";

const savedEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SUPPORT_CHAT_ID = " 999 ";
  redisSetMock.mockResolvedValue("OK");
  redisGetMock.mockResolvedValue(null);
  redisEvalMock.mockResolvedValue(1);
  sendTelegramMessageMock.mockResolvedValue(true);
});

afterEach(() => {
  process.env = { ...savedEnv };
});

const incident = (error = new Error("Unknown argument `analysisVersion`. Available options are marked with ?.")) => ({
  stage: "analyze" as const,
  queueJobId: "173",
  pipelineJobId: "cmtmp3flc001e1rit80gyo5mx",
  attemptsMade: 3,
  error,
});

describe("pipeline incident monitor", () => {
  it("claims a fingerprint atomically and sends one bounded alert", async () => {
    expect(await notifyPipelineIncident(incident())).toBe(true);

    expect(redisSetMock).toHaveBeenCalledWith(
      expect.stringMatching(/^pipeline-incident:.*:sending$/),
      expect.any(String),
      "EX",
      600,
      "NX"
    );
    expect(redisSetMock).toHaveBeenCalledWith(
      expect.stringMatching(/^pipeline-incident:.*:delivered$/),
      expect.any(String),
      "EX",
      PIPELINE_INCIDENT_TTL_SECONDS
    );
    expect(sendTelegramMessageMock).toHaveBeenCalledWith(
      "999",
      expect.stringContaining("stage=analyze")
    );
    const text = String(sendTelegramMessageMock.mock.calls[0][1]);
    expect(text).toContain("job=cmtmp3flc001e1rit80gyo5mx");
    expect(text).toContain("attempts=3");
    expect(text).toContain("Unknown argument `analysisVersion`");
    expect(text.length).toBeLessThan(900);
  });

  it("does not send when another worker already claimed the fingerprint", async () => {
    redisSetMock.mockResolvedValue(null);

    expect(await notifyPipelineIncident(incident())).toBe(false);
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();
  });

  it("releases the lease when Telegram refuses the alert", async () => {
    sendTelegramMessageMock.mockResolvedValue(false);

    expect(await notifyPipelineIncident(incident())).toBe(false);
    expect(redisEvalMock).toHaveBeenCalledWith(expect.any(String), 1, expect.stringMatching(/:sending$/), expect.any(String));
  });

  it("does nothing when the owner chat is not configured", async () => {
    delete process.env.SUPPORT_CHAT_ID;

    expect(await notifyPipelineIncident(incident())).toBe(false);
    expect(redisSetMock).not.toHaveBeenCalled();
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();
  });

  it("deduplicates matching root-cause lines even when job ids differ", async () => {
    await notifyPipelineIncident(incident(new Error("job cmt111 failed\nUnknown argument `analysisVersion`. Available options are marked with ?.")));
    await notifyPipelineIncident(incident(new Error("job cmt222 failed\nUnknown argument `analysisVersion`. Available options are marked with ?.")));

    const leaseKeys = redisSetMock.mock.calls.filter((call) => String(call[0]).endsWith(":sending"));
    expect(leaseKeys[0][0]).toBe(leaseKeys[1][0]);
  });

  it("does not merge distinct multiline errors that share a generic trailer", async () => {
    await notifyPipelineIncident(incident(new Error("Unknown argument `analysisVersion`\nAvailable options are marked with ?.")));
    await notifyPipelineIncident(incident(new Error("Unknown argument `durationSec`\nAvailable options are marked with ?.")));

    const leaseKeys = redisSetMock.mock.calls.filter((call) => String(call[0]).endsWith(":sending"));
    expect(leaseKeys[0][0]).not.toBe(leaseKeys[1][0]);
  });
});
