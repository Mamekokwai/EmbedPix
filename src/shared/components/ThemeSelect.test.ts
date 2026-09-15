import { describe, expect, it } from "vitest";
import { getNextOptionIndex } from "./ThemeSelect";

describe("theme select keyboard navigation", () => {
  it("wraps arrow navigation around the option list", () => {
    expect(getNextOptionIndex(0, 3, "ArrowUp")).toBe(2);
    expect(getNextOptionIndex(2, 3, "ArrowDown")).toBe(0);
  });

  it("supports Home and End without changing the option list", () => {
    expect(getNextOptionIndex(1, 3, "Home")).toBe(0);
    expect(getNextOptionIndex(1, 3, "End")).toBe(2);
    expect(getNextOptionIndex(1, 3, "PageDown")).toBe(1);
    expect(getNextOptionIndex(1, 0, "ArrowDown")).toBe(-1);
  });
});
