import { describe, expect, it } from "vitest";
import {
  checkForUpdates,
  compareVersions,
} from "./updateGateway";

function response(payload: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => payload } as Response;
}

describe("update gateway", () => {
  it("compares release versions without treating a v prefix as meaningful", () => {
    expect(compareVersions("v1.2.0", "1.1.9")).toBe(1);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.1.9", "1.2.0")).toBe(-1);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.11")).toBe(-1);
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(-1);
    expect(compareVersions("not-a-version", "1.0.0")).toBe(0);
  });

  it("maps a valid GitHub release and detects a newer version", async () => {
    const result = await checkForUpdates(
      async () => response({
        tag_name: "v0.2.0",
        body: "新增 RGB565 导出。",
        published_at: "2026-09-15T00:00:00Z",
        html_url: "https://github.com/Mamekokwai/EngiFormat/releases/tag/v0.2.0",
      }),
      "0.1.0",
    );

    expect(result).toMatchObject({
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      releaseNotes: "新增 RGB565 导出。",
      updateAvailable: true,
    });
  });

  it("rejects invalid payloads and server failures with stable error kinds", async () => {
    await expect(checkForUpdates(async () => response({ tag_name: "preview" }), "0.1.0"))
      .rejects.toMatchObject({ kind: "invalid-response" });
    await expect(checkForUpdates(async () => response({}, false, 503), "0.1.0"))
      .rejects.toMatchObject({ kind: "server" });
    await expect(checkForUpdates(async () => { throw new Error("offline"); }, "0.1.0"))
      .rejects.toMatchObject({ kind: "network" });
  });
});
