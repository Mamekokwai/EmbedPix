import { describe, expect, it } from "vitest";
import {
  computeSelectPlacement,
  SELECT_LIST_MAX_HEIGHT,
  SELECT_PLACEMENT_GAP,
  SELECT_VIEWPORT_MARGIN,
} from "./themeSelectPlacement";

describe("custom dropdown placement", () => {
  it("opens below the trigger when the space underneath fits the whole list", () => {
    const placement = computeSelectPlacement(
      { left: 100, top: 100, bottom: 130, width: 200 },
      { width: 1200, height: 800 },
      145,
    );
    expect(placement.top).toBe(130 + SELECT_PLACEMENT_GAP);
    expect(placement.maxHeight).toBe(SELECT_LIST_MAX_HEIGHT);
    expect(placement.left).toBe(100);
    expect(placement.width).toBe(200);
  });

  it("flips above the trigger in a narrow short window", () => {
    // 与 480×560 实测一致：触发器 top=283/bottom=313，浮层占位 145，落在 133，与触发器保持 5px。
    const placement = computeSelectPlacement(
      { left: 72, top: 283, bottom: 313, width: 186 },
      { width: 480, height: 560 },
      145,
    );
    expect(placement.top).toBe(133);
    expect(placement.top + 145).toBe(283 - SELECT_PLACEMENT_GAP);
    expect(placement.maxHeight).toBe(SELECT_LIST_MAX_HEIGHT);
    expect(placement.width).toBe(186);
  });

  it("keeps the flipped list inside the viewport when the trigger sits near the bottom edge", () => {
    const placement = computeSelectPlacement(
      { left: 72, top: 520, bottom: 550, width: 186 },
      { width: 480, height: 560 },
      400,
    );
    expect(placement.top).toBeGreaterThanOrEqual(SELECT_VIEWPORT_MARGIN);
    expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(560);
  });

  it("stays below the trigger when there is no room above either", () => {
    const placement = computeSelectPlacement(
      { left: 10, top: 20, bottom: 50, width: 100 },
      { width: 400, height: 300 },
      100,
    );
    expect(placement.top).toBe(50 + SELECT_PLACEMENT_GAP);
    expect(placement.maxHeight).toBe(300 - 50 - SELECT_PLACEMENT_GAP - SELECT_VIEWPORT_MARGIN);
  });

  it("clamps the list to the viewport when the trigger hugs the right edge", () => {
    const placement = computeSelectPlacement(
      { left: 1150, top: 100, bottom: 130, width: 200 },
      { width: 1200, height: 800 },
      145,
    );
    expect(placement.left).toBe(1200 - 200 - SELECT_VIEWPORT_MARGIN);
  });

  it("shrinks the list width when the viewport is narrower than the trigger", () => {
    const placement = computeSelectPlacement(
      { left: 10, top: 100, bottom: 130, width: 300 },
      { width: 180, height: 400 },
      145,
    );
    expect(placement.width).toBe(180 - 2 * SELECT_VIEWPORT_MARGIN);
    expect(placement.left).toBe(SELECT_VIEWPORT_MARGIN);
  });

  it("never reports a negative max height in a degenerate window", () => {
    const placement = computeSelectPlacement(
      { left: 10, top: 5, bottom: 35, width: 100 },
      { width: 400, height: 20 },
      145,
    );
    expect(placement.maxHeight).toBe(0);
  });
});
