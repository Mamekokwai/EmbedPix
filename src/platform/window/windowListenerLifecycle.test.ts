import { describe, expect, it } from "vitest";
import { retainWindowListener, type WindowListenerLifecycle } from "./windowListenerLifecycle";

describe("window listener lifecycle", () => {
  it("runs a late cleanup immediately after disposal", () => {
    const lifecycle: WindowListenerLifecycle = { disposed: true };
    let calls = 0;
    retainWindowListener(lifecycle, () => undefined, () => { calls += 1; });
    expect(calls).toBe(1);
  });

  it("saves cleanup while mounted", () => {
    const lifecycle: WindowListenerLifecycle = { disposed: false };
    let saved: (() => void) | undefined;
    const cleanup = () => undefined;
    retainWindowListener(lifecycle, (value) => { saved = value; }, cleanup);
    expect(saved).toBe(cleanup);
  });
});
