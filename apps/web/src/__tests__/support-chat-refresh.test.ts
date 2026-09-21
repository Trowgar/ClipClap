import { expect, it, vi } from "vitest";

import { refreshSupportConversation } from "../../components/support-chat";

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
