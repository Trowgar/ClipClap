import { expect, it, vi } from "vitest";

import {
  beginSupportRefresh,
  refreshSupportConversation,
} from "../../components/support-chat";

it("does not mark replies read when a refresh is aborted after its GET", async () => {
  let resolveGet!: (response: Response) => void;
  const fetchMock = vi.fn().mockImplementationOnce((_url, init: RequestInit) => {
    expect(init.signal).toBeInstanceOf(AbortSignal);
    return new Promise<Response>(resolve => { resolveGet = resolve; });
  });
  vi.stubGlobal("fetch", fetchMock);
  const controller = new AbortController();

  const refresh = refreshSupportConversation(controller.signal);
  controller.abort();
  resolveGet({
    ok: true,
    json: async () => ({ messages: [], unreadIds: ["reply-1"] }),
  } as Response);

  await expect(refresh).resolves.toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("refreshes and marks replies read with a fresh controller", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messages: [], unreadIds: ["reply-1"] }),
    })
    .mockResolvedValueOnce({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
  const controller = new AbortController();

  await expect(refreshSupportConversation(controller.signal)).resolves.toEqual({
    messages: [],
    markedRead: true,
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1][0]).toBe("/api/support/read");
  expect(fetchMock.mock.calls[1][1].signal).toBe(controller.signal);
});

it("aborts a stale refresh before starting the latest request", async () => {
  let resolveOld!: (response: Response) => void;
  const fetchMock = vi.fn()
    .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveOld = resolve; }))
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messages: [{ id: "new" }], unreadIds: ["new-reply"] }),
    })
    .mockResolvedValueOnce({ ok: true });
  vi.stubGlobal("fetch", fetchMock);

  const oldController = new AbortController();
  const oldRefresh = refreshSupportConversation(oldController.signal);
  const latestController = beginSupportRefresh(oldController);
  const latestRefresh = refreshSupportConversation(latestController.signal);

  await expect(latestRefresh).resolves.toMatchObject({
    messages: [{ id: "new" }],
    markedRead: true,
  });
  resolveOld({
    ok: true,
    json: async () => ({ messages: [{ id: "old" }], unreadIds: ["old-reply"] }),
  } as Response);
  await expect(oldRefresh).resolves.toBeNull();

  expect(oldController.signal.aborted).toBe(true);
  expect(latestController.signal.aborted).toBe(false);
  expect(fetchMock.mock.calls.filter(([url]) => url === "/api/support/read")).toHaveLength(1);
  expect(fetchMock.mock.calls[2][1].body).toContain("new-reply");
});
