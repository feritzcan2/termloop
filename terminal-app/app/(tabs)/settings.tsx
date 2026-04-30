import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Switch,
  TouchableOpacity,
} from 'react-native';
import Slider from '@react-native-community/slider';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { getAllThemes } from '../../lib/themes';
import Constants from 'expo-constants';

const SETTINGS_KEY = 'terminal_settings';

interface Settings {
  defaultTheme: string;
  fontSize: number;
  hapticEnabled: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  defaultTheme: 'dracula',
  fontSize: 14,
  hapticEnabled: true,
};

export default function SettingsScreen() {
  const router = useRouter();
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const themes = getAllThemes();

  useEffect(() => {
    AsyncStorage.getItem(SETTINGS_KEY).then((raw) => {
      if (raw) setSettings(JSON.parse(raw));
    });
  }, []);

  const updateSetting = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.sectionTitle}>Appearance</Text>

      <Text style={styles.label}>Default Theme</Text>
      <View style={styles.themeGrid}>
        {themes.map((t) => (
          <TouchableOpacity
            key={t.id}
            style={[
              styles.themeChip,
              { backgroundColor: t.colors.background },
              settings.defaultTheme === t.id && styles.themeChipActive,
            ]}
            onPress={() => updateSetting('defaultTheme', t.id)}
          >
            <Text style={[styles.themeChipText, { color: t.colors.foreground }]}>
              {t.name}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.label}>Font Size: {settings.fontSize}px</Text>
      <Slider
        style={styles.slider}
        minimumValue={10}
        maximumValue={24}
        step={1}
        value={settings.fontSize}
        onSlidingComplete={(v: number) => updateSetting('fontSize', v)}
        minimumTrackTintColor="#bd93f9"
        maximumTrackTintColor="#44475a"
        thumbTintColor="#bd93f9"
      />

      <Text style={styles.sectionTitle}>Interaction</Text>

      <View style={styles.row}>
        <Text style={styles.label}>Haptic Feedback</Text>
        <Switch
          value={settings.hapticEnabled}
          onValueChange={(v) => updateSetting('hapticEnabled', v)}
          trackColor={{ false: '#44475a', true: '#bd93f9' }}
          thumbColor="#f8f8f2"
        />
      </View>

      <Text style={styles.sectionTitle}>Preview</Text>
      <TouchableOpacity
        style={styles.previewBtn}
        onPress={() => router.push('/termloop/cmuxfork')}
      >
        <Text style={styles.previewBtnText}>Open epic tree preview ›</Text>
      </TouchableOpacity>

      <Text style={styles.sectionTitle}>About</Text>
      <Text style={styles.aboutText}>
        Terminal App v{Constants.expoConfig?.version ?? '1.0.0'}
      </Text>
      <Text style={styles.aboutSubtext}>
        Built with Expo + xterm.js
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#282a36',
  },
  content: {
    padding: 20,
    paddingBottom: 40,
  },
  sectionTitle: {
    color: '#bd93f9',
    fontSize: 14,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 24,
    marginBottom: 12,
  },
  label: {
    color: '#f8f8f2',
    fontSize: 14,
    marginBottom: 8,
    marginTop: 8,
  },
  themeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  themeChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  themeChipActive: {
    borderColor: '#bd93f9',
  },
  themeChipText: {
    fontSize: 13,
    fontWeight: '600',
  },
  slider: {
    width: '100%',
    height: 40,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  aboutText: {
    color: '#f8f8f2',
    fontSize: 14,
  },
  aboutSubtext: {
    color: '#6272a4',
    fontSize: 12,
    marginTop: 4,
  },
  previewBtn: {
    backgroundColor: '#3d6dff',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 6,
    alignSelf: 'flex-start',
  },
  previewBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1,
  },
});
