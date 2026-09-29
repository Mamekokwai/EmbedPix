import { describe, expect, it } from "vitest";
import { downloadBlob, type DownloadBlobDependencies } from "./downloadBlob";

describe("downloadBlob", () => {
  it("keeps the Blob URL alive through the click and revokes it afterward", () => {
    const events: string[] = [];
    let deferred: (() => void) | undefined;
    const dependencies: DownloadBlobDependencies = {
      createObjectURL: () => { events.push("create"); return "blob:test"; },
      revokeObjectURL: (url) => events.push(`revoke:${url}`),
      createLink: () => ({ href: "", download: "", click: () => events.push("click") }),
      defer: (callback) => { deferred = callback; },
    };

    downloadBlob(new Blob(["data"], { type: "text/plain" }), "test.txt", dependencies);

    expect(events).toEqual(["create", "click"]);
    expect(deferred).toBeDefined();
    deferred?.();
    expect(events).toEqual(["create", "click", "revoke:blob:test"]);
  });

  it("still schedules cleanup when clicking the link throws", () => {
    let deferred: (() => void) | undefined;
    let revoked = false;
    const dependencies: DownloadBlobDependencies = {
      createObjectURL: () => "blob:failed-click",
      revokeObjectURL: () => { revoked = true; },
      createLink: () => ({ href: "", download: "", click: () => { throw new Error("click failed"); } }),
      defer: (callback) => { deferred = callback; },
    };

    expect(() => downloadBlob(new Blob(["data"]), "test.txt", dependencies)).toThrow("click failed");
    expect(revoked).toBe(false);
    deferred?.();
    expect(revoked).toBe(true);
  });
});
