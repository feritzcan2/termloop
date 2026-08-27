import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { Banner, Card, PrimaryButton, SecondaryButton, SectionHeader } from "@/components/primitives";
import { MockBadge, MockNotice, Screen, ScreenHeader } from "@/components/screen";
import { useConnections } from "@/features/connection/connection-store";
import { color, radius, space } from "@/theme/tokens";
import { fontFamily, text } from "@/theme/typography";

/// QR and paste carry the exact same versioned bootstrap bytes. The camera therefore
/// adds no second pairing protocol and the secure connection adapter remains the only
/// place that parses or stores credentials.
export default function PairRoute() {
  const router = useRouter();
  const connections = useConnections();
  const [code, setCode] = useState("");
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [manual, setManual] = useState(false);
  const [scanLocked, setScanLocked] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();

  const pairValue = (value: string) => {
    if (pairing || value.trim().length === 0) return;
    setPairing(true);
    setError(undefined);
    void connections.pair(value).then(
      () => router.back(),
      (cause: unknown) => {
        setPairing(false);
        setError(cause instanceof Error ? cause.message : "This computer could not be paired.");
      },
    );
  };
  const pair = () => pairValue(code);
  const scan = (result: BarcodeScanningResult) => {
    if (scanLocked || pairing) return;
    setScanLocked(true);
    pairValue(result.data);
  };

  return (
    <Screen>
      <ScreenHeader
        title="Pair a computer"
        right={
          <View style={styles.headerRight}>
            <MockBadge />
            <Pressable
              onPress={() => router.back()}
              accessibilityRole="button"
              accessibilityLabel="Close"
              hitSlop={12}
              style={styles.close}
            >
              <Text style={styles.closeGlyph}>✕</Text>
            </Pressable>
          </View>
        }
      />
      <ScrollView contentContainerStyle={styles.content}>
        <MockNotice detail="Pairing returns to the existing mock computer. No code is parsed or credential stored in mock mode." />

        {error === undefined ? null : <Banner kind="danger" message={error} />}

        <View style={styles.section}>
          <SectionHeader label="On your computer" />
          <Text style={styles.body}>
            Keep Tailscale connected on both devices. In TermLoop Desktop, choose
            <Text style={styles.mono}> Connect Mobile</Text>, then scan its QR code.
          </Text>
        </View>

        {manual ? (
          <View style={styles.section}>
            <SectionHeader label="Pair code" />
            <TextInput
              value={code}
              onChangeText={setCode}
              editable={!pairing}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Paste TLMP1 code"
              placeholderTextColor={color.textMuted}
              accessibilityLabel="TermLoop Mobile pair code"
              style={styles.codeInput}
              onSubmitEditing={pair}
            />
            <PrimaryButton
              label={pairing ? "Pairing…" : "Pair this computer"}
              onPress={pair}
              disabled={pairing || code.trim().length === 0}
            />
            <SecondaryButton label="Scan QR instead" onPress={() => setManual(false)} />
          </View>
        ) : (
          <View style={styles.section}>
            <SectionHeader label="Scan QR" />
            {permission === null ? (
              <View style={styles.cameraPlaceholder}><Text style={styles.cameraHint}>Preparing camera…</Text></View>
            ) : permission.granted ? (
              <View style={styles.cameraFrame}>
                <CameraView
                  style={StyleSheet.absoluteFill}
                  facing="back"
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  onBarcodeScanned={scanLocked || pairing ? undefined : scan}
                />
                <View pointerEvents="none" style={styles.scanTarget} />
                {scanLocked ? (
                  <View style={styles.scanOverlay}>
                    <Text style={styles.scanOverlayText}>{pairing ? "Pairing…" : "QR could not be paired."}</Text>
                    {!pairing ? <SecondaryButton label="Scan again" onPress={() => { setError(undefined); setScanLocked(false); }} /> : null}
                  </View>
                ) : null}
              </View>
            ) : (
              <View style={styles.cameraPlaceholder}>
                <Text style={styles.cameraHint}>Camera access is used only to read the pairing QR code.</Text>
                {permission.canAskAgain
                  ? <PrimaryButton label="Allow camera" onPress={() => { void requestPermission(); }} />
                  : <PrimaryButton label="Open Settings" onPress={() => { void Linking.openSettings(); }} />}
              </View>
            )}
            <SecondaryButton label="Enter code instead" onPress={() => setManual(true)} />
          </View>
        )}

        <View style={styles.section}>
          <SectionHeader label="What pairing will grant" />
          <Card>
            <View style={styles.consent}>
              {/*
                The whole consent surface for owner-mobile mode is this one sentence. It
                states both halves honestly — reading projections and typing into
                terminals — because terminal input is worktree mutation by proxy and
                calling this a read-only client would be false.
              */}
              <Text style={styles.consentText}>
                This phone will be able to read your projects and type into your agent terminals.
              </Text>
            </View>
          </Card>
        </View>

        <Banner
          kind="info"
          message="The code contains this daemon run's temporary read and terminal credentials. They are saved in the platform secure store, never in endpoint URLs or ordinary local storage. Rerun Mobile Access after a daemon restart."
        />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerRight: { flexDirection: "row", alignItems: "center", gap: space.sm },
  close: { width: 32, height: 44, alignItems: "flex-end", justifyContent: "center" },
  closeGlyph: { color: color.textSecondary, fontSize: 17 },
  content: { gap: space.lg, padding: space.screen, paddingBottom: space.xl },
  section: { gap: 6 },
  body: { ...text.body, lineHeight: 20 },
  mono: { fontFamily: fontFamily.mono, color: color.text },
  codeInput: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: color.borderStrong,
    borderRadius: radius.control,
    backgroundColor: color.bgTerminal,
    color: color.text,
    fontFamily: fontFamily.mono,
    fontSize: 12,
    paddingHorizontal: space.md,
  },
  cameraFrame: {
    position: "relative",
    height: 330,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: color.borderStrong,
    borderRadius: radius.card,
    backgroundColor: color.bgTerminal,
  },
  cameraPlaceholder: {
    minHeight: 190,
    alignItems: "center",
    justifyContent: "center",
    gap: space.md,
    padding: space.lg,
    borderWidth: 1,
    borderColor: color.borderStrong,
    borderRadius: radius.card,
    backgroundColor: color.bgTerminal,
  },
  cameraHint: { ...text.body, color: color.textSecondary, textAlign: "center" },
  scanTarget: {
    position: "absolute",
    top: 48,
    right: 38,
    bottom: 48,
    left: 38,
    borderWidth: 2,
    borderColor: color.accentStrong,
    borderRadius: radius.card,
  },
  scanOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: space.md,
    padding: space.lg,
    backgroundColor: "rgba(30,35,37,.88)",
  },
  scanOverlayText: { ...text.body, color: color.text, textAlign: "center" },
  consent: { padding: space.md },
  consentText: { ...text.body, lineHeight: 20 },
});
