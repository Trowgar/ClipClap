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

it("admits one refresh at a time and allows the next after completion", async () => {
  let resolveCurrent!: (response: Response) => void;
  const fetchMock = vi.fn()
    .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveCurrent = resolve; }))
    .mockResolvedValueOnce({ ok: true })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messages: [{ id: "new" }], unreadIds: ["new-reply"] }),
    })
    .mockResolvedValueOnce({ ok: true });
  vi.stubGlobal("fetch", fetchMock);

  const currentController = beginSupportRefresh(null)!;
  const currentRefresh = refreshSupportConversation(currentController.signal);
  expect(beginSupportRefresh(currentController)).toBeNull();
  expect(currentController.signal.aborted).toBe(false);

  resolveCurrent({
    ok: true,
    json: async () => ({ messages: [{ id: "current" }], unreadIds: ["current-reply"] }),
  } as Response);
  await expect(currentRefresh).resolves.toMatchObject({
    messages: [{ id: "current" }],
    markedRead: true,
  });

  const latestController = beginSupportRefresh(null)!;
  const latestRefresh = refreshSupportConversation(latestController.signal);
  await expect(latestRefresh).resolves.toMatchObject({
    messages: [{ id: "new" }],
    markedRead: true,
  });

  expect(fetchMock.mock.calls.filter(([url]) => url === "/api/support/read")).toHaveLength(2);
});
