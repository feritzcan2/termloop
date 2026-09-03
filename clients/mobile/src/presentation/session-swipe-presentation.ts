export const SESSION_SWIPE_ACTION_WIDTH = 92;

export function sessionSwipeTranslation(start: number, delta: number): number {
  return Math.max(-SESSION_SWIPE_ACTION_WIDTH, Math.min(0, start + delta));
}

export function settledSessionSwipeTranslation(value: number, velocityX: number): number {
  const openingQuickly = velocityX < -0.45;
  const closingQuickly = velocityX > 0.45;
  if (!closingQuickly && (openingQuickly || value <= -(SESSION_SWIPE_ACTION_WIDTH / 2))) {
    return -SESSION_SWIPE_ACTION_WIDTH;
  }
  return 0;
}
