import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { colors } from "../lib/theme";

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          headerTitleStyle: { fontSize: 16, fontWeight: "600" },
          headerBackTitle: "",
          headerBackButtonDisplayMode: "minimal",
          contentStyle: { backgroundColor: colors.bg },
          headerShadowVisible: false,
        }}
      >
        <Stack.Screen name="index" options={{ title: "Connections" }} />
        <Stack.Screen name="connections/scan" options={{ title: "Pair" }} />
        <Stack.Screen name="connections/new" options={{ title: "Manual setup" }} />
        <Stack.Screen name="connected/index" options={{ title: "Connected" }} />
        <Stack.Screen name="connected/terminal" options={{ title: "Terminal" }} />
      </Stack>
    </GestureHandlerRootView>
  );
}
