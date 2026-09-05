export type BackNavigationAction = "back" | "fallback";

/// A cold deep link or an OTA reload can restore a detail route without putting
/// Home underneath it. Calling `back` in that state leaves the native app instead
/// of navigating inside TermLoop, so detail headers must replace to a safe route.
export function backNavigationAction(canGoBack: boolean): BackNavigationAction {
  return canGoBack ? "back" : "fallback";
}
