import React from 'react';
import { Tabs } from 'expo-router';
import { StyleSheet, Text } from 'react-native';
import { palette } from '../../lib/palette';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarStyle: {
          backgroundColor: palette.bg,
          borderTopColor: palette.border,
          borderTopWidth: StyleSheet.hairlineWidth,
        },
        tabBarActiveTintColor: palette.blue,
        tabBarInactiveTintColor: palette.ink3,
        tabBarLabelStyle: {
          fontSize: 10.5,
          fontWeight: '600',
          letterSpacing: 0.2,
        },
        headerStyle: { backgroundColor: palette.bg },
        headerTintColor: palette.ink1,
        headerTitleStyle: {
          fontSize: 17,
          fontWeight: '600',
        },
        headerShadowVisible: false,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          headerShown: false,
          title: 'Hosts',
          tabBarIcon: ({ color, size }) => (
            <Text style={{ color, fontSize: size ?? 20, fontWeight: '600' }}>H</Text>
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size }) => (
            <Text style={{ color, fontSize: size ?? 20, fontWeight: '600' }}>S</Text>
          ),
        }}
      />
    </Tabs>
  );
}
