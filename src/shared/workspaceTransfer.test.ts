import { describe, expect, it } from "vitest";
import { DEFAULT_GIF_MAKER_PREFERENCES } from "../features/gif-maker/gifMakerPreferences";
import { DEFAULT_APP_PREFERENCES } from "../platform/preferences/appPreferences";
import { exportWorkspaceSnapshot, importWorkspaceSnapshot } from "./workspaceTransfer";

const image = { type: "image" as const, parameters: DEFAULT_APP_PREFERENCES, outputLocation: "directory" as const, outputDirectory: "E:\\out", namingTemplate: "{name}_{index}.png", sources: [{ path: "E:\\images\\a.png", fileName: "a.png", width: 10, height: 20, sizeBytes: 100 }] };
const gif = { type: "gif" as const, parameters: DEFAULT_GIF_MAKER_PREFERENCES, outputLocation: "directory", sources: [{ path: "E:\\images\\a.png", fileName: "a.png" }], frames: [{ index: 0, durationMs: 100, width: 10, height: 20 }] };

describe("workspace transfer", () => {
  it("round trips image and GIF metadata without binary data", () => {
    const json = exportWorkspaceSnapshot([image, gif]);
    expect(json).not.toContain("Blob"); expect(json).not.toContain("data:");
    expect(importWorkspaceSnapshot(json).workspaces).toHaveLength(2);
  });
  it("rejects dangerous paths, prototype pollution and oversized JSON", () => {
    expect(() => exportWorkspaceSnapshot([{ ...image, sources: [{ ...image.sources[0], path: "E:\\..\\secret.png" }] }])).toThrow("unsafe");
    const payload = exportWorkspaceSnapshot([image]).replace('"type":"image"', '"type":"image","__proto__":{}');
    expect(() => importWorkspaceSnapshot(payload)).toThrow("unsupported fields");
    expect(() => importWorkspaceSnapshot("x".repeat(1_048_577))).toThrow("1 MiB");
  });
  it("reports missing source paths without discarding the workspace", () => {
    const restored = importWorkspaceSnapshot(exportWorkspaceSnapshot([{ ...image, sources: [{ ...image.sources[0], path: "missing:E:\\old.png" }] }]));
    expect(restored.workspaces).toHaveLength(1); expect(restored.issues[0]).toMatchObject({ kind: "missing-path" });
  });
});
