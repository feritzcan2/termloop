export type BackNavigationAction = "back" | "dismissTo" | "fallback";

/// A cold deep link or an OTA reload can restore a detail route without putting
/// Home underneath it. Calling `back` in that state leaves the native app instead
/// of navigating inside TermLoop, so detail headers must replace to a safe route.
export function backNavigationAction(
  canGoBack: boolean,
  hasExplicitDestination: boolean,
): BackNavigationAction {
  if (hasExplicitDestination) return "dismissTo";
  return canGoBack ? "back" : "fallback";
}
