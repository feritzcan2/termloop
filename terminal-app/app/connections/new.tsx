import { useRouter } from "expo-router";
import { useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { upsertConnection } from "../../lib/connections";
import { colors } from "../../lib/theme";

export default function ManualSetupScreen() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("7878");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);

  const onSave = async () => {
    if (!name.trim() || !host.trim() || !/^\d+$/.test(port.trim())) {
      Alert.alert(
        "Missing fields",
        "Name, host, and a numeric port are required."
      );
      return;
    }
    setSaving(true);
    try {
      await upsertConnection({
        name: name.trim(),
        host: host.trim(),
        port: Number.parseInt(port.trim(), 10),
        password: password.trim() || undefined,
      });
      router.back();
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={["bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={styles.form}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.helper}>
            Manual setup is a fallback. Prefer Scan pairing QR when possible.
          </Text>
          <Field label="Name">
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="My laptop"
              placeholderTextColor={colors.placeholder}
              autoCapitalize="none"
            />
          </Field>
          <Field label="Host">
            <TextInput
              style={styles.input}
              value={host}
              onChangeText={setHost}
              placeholder="192.168.1.20"
              placeholderTextColor={colors.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
          </Field>
          <Field label="Port">
            <TextInput
              style={styles.input}
              value={port}
              onChangeText={setPort}
              placeholder="7878"
              placeholderTextColor={colors.placeholder}
              keyboardType="number-pad"
            />
          </Field>
          <Field label="Password">
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              placeholder="auth.login password"
              placeholderTextColor={colors.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />
          </Field>
          <Pressable
            style={[styles.saveBtn, saving && { opacity: 0.6 }]}
            onPress={onSave}
            disabled={saving}
          >
            <Text style={styles.saveBtnText}>{saving ? "Saving…" : "Save"}</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  form: { padding: 16, gap: 16 },
  helper: { color: colors.sub, fontSize: 12 },
  field: { gap: 6 },
  label: {
    color: colors.label,
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  input: {
    backgroundColor: colors.inputBg,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    color: colors.text,
    fontSize: 15,
    borderWidth: 1,
    borderColor: colors.border,
  },
  saveBtn: {
    marginTop: 8,
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: "center",
  },
  saveBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});
