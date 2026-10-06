export interface TriggerRect {
  left: number;
  top: number;
  bottom: number;
  width: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface SelectPlacement {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

export const SELECT_LIST_MAX_HEIGHT = 240;
export const SELECT_PLACEMENT_GAP = 5;
export const SELECT_VIEWPORT_MARGIN = 8;

// 浮层与视口上下边缘之间同时要留出边距和触发器间隙，合成一个量，避免两处各算一遍后漂移。
const EDGE = SELECT_PLACEMENT_GAP + SELECT_VIEWPORT_MARGIN;

export function computeSelectPlacement(
  trigger: TriggerRect,
  viewport: ViewportSize,
  listHeight: number,
): SelectPlacement {
  const below = viewport.height - trigger.bottom - EDGE;
  const above = trigger.top - EDGE;
  // 只有下方放不下整块浮层、且上方确实更宽裕时才上翻，避免临界高度来回跳动。
  const upward = below < SELECT_LIST_MAX_HEIGHT && above > below;
  const maxHeight = Math.max(0, Math.min(SELECT_LIST_MAX_HEIGHT, upward ? above : below));
  // 上翻时按浮层实际占位高度贴着触发器放，比可用空间矮才不会浮在半空。
  const height = Math.min(listHeight, maxHeight);
  return {
    left: Math.max(
      SELECT_VIEWPORT_MARGIN,
      Math.min(trigger.left, viewport.width - trigger.width - SELECT_VIEWPORT_MARGIN),
    ),
    top: upward ? trigger.top - height - SELECT_PLACEMENT_GAP : trigger.bottom + SELECT_PLACEMENT_GAP,
    width: Math.min(trigger.width, viewport.width - 2 * SELECT_VIEWPORT_MARGIN),
    maxHeight,
  };
}
