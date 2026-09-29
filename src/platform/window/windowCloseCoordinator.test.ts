import { afterEach, describe, expect, it, vi } from "vitest";
import { registerWindowCloseHandler, requestWindowClose, resetWindowCloseCoordinatorForTests } from "./windowCloseCoordinator";

describe("window close coordinator", () => {
  afterEach(() => {
    resetWindowCloseCoordinatorForTests();
    vi.useRealTimers();
  });

  it("waits for registered handlers and unregisters them", async () => {
    const calls: string[] = [];
    const unregister = registerWindowCloseHandler(async () => {
      await Promise.resolve();
      calls.push("close");
    });

    await requestWindowClose();
    unregister();
    await requestWindowClose();

    expect(calls).toEqual(["close"]);
  });

  it("deduplicates simultaneous close requests and bounds a stuck handler", async () => {
    vi.useFakeTimers();
    const handler = vi.fn(() => new Promise<void>(() => undefined));
    registerWindowCloseHandler(handler);
    const first = requestWindowClose();
    const second = requestWindowClose();
    expect(first).toBe(second);

    await vi.advanceTimersByTimeAsync(1500);
    await expect(first).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledOnce();
  });
});
