import { describe, expect, it } from "vitest";
import { DEFAULT_GIF_MAKER_PREFERENCES } from "./gifMakerPreferences";
import { createGifCustomPreset, loadGifCustomPresets, saveGifCustomPresets } from "./gifCustomPresets";

function storage() { let value: string | null = null; return { getItem: () => value, setItem: (_key: string, next: string) => { value = next; } }; }

describe("GIF custom presets", () => {
  it("round trips a versioned local preset", () => { const store = storage(); const preset = createGifCustomPreset("屏幕动画", DEFAULT_GIF_MAKER_PREFERENCES); saveGifCustomPresets([preset], store); expect(loadGifCustomPresets(store)).toEqual([preset]); });
  it("rejects an old schema", () => expect(loadGifCustomPresets({ getItem: () => JSON.stringify({ version: 0, presets: [] }) })).toEqual([]));
});
