/// How far fingers must spread or close, relative to where the step began, before
/// the text size moves one preset. Re-baselined after each step, so one long pinch
/// walks through several sizes instead of jumping straight to the end.
export const PINCH_STEP_RATIO = 1.18;

export interface PinchTouch {
  readonly pageX: number;
  readonly pageY: number;
}

export function pinchDistance(touches: readonly PinchTouch[]): number | undefined {
  if (touches.length !== 2) return undefined;
  const [first, second] = touches as readonly [PinchTouch, PinchTouch];
  return Math.hypot(first.pageX - second.pageX, first.pageY - second.pageY);
}

export function pinchStep(baseline: number, distance: number): -1 | 0 | 1 {
  if (baseline <= 0) return 0;
  const ratio = distance / baseline;
  if (ratio >= PINCH_STEP_RATIO) return 1;
  if (ratio <= 1 / PINCH_STEP_RATIO) return -1;
  return 0;
}
