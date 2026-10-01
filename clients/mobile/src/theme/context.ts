import { createContext, useContext } from "react";
import { StyleSheet, type ImageStyle, type TextStyle, type ViewStyle } from "react-native";

import { lightTheme, type MobileTheme } from "./tokens";

export const ThemeContext = createContext<MobileTheme>(lightTheme);

export function useTheme(): MobileTheme {
  return useContext(ThemeContext);
}

export function createThemedStyles<T extends { [Key in keyof T]: ViewStyle | TextStyle | ImageStyle }>(
  create: (theme: MobileTheme) => T,
): () => T {
  const cache = new WeakMap<MobileTheme, T>();
  return function useThemedStyles() {
    const theme = useTheme();
    let styles = cache.get(theme);
    if (styles === undefined) {
      styles = StyleSheet.create(create(theme));
      cache.set(theme, styles);
    }
    return styles;
  };
}
