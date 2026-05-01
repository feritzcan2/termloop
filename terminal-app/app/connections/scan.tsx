import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
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
import {
  findConnectionMetaByEndpoint,
  markConnected,
  upsertConnection,
} from "../../lib/connections";
import { friendlyTransportError } from "../../lib/errors";
import { openSession } from "../../lib/session";
import { TcpTransport } from "../../lib/tcp-transport";
import {
  createTermLoopClient,
  parsePairingPayload,
} from "../../lib/termloop-client";
import { colors, monoFont } from "../../lib/theme";

type PermissionState = "checking" | "granted" | "prompt" | "denied";

export default function ScanPairingScreen() {
  const router = useRouter();
  const [pasted, setPasted] = useState("");
  const [deviceName, setDeviceName] = useState(defaultDeviceName());
  const [busy, setBusy] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const lastScanRef = useRef<string | null>(null);

  const claim = useCallback(
    async (raw: string) => {
      if (busy) return;
      setBusy(true);
      try {
        const payload = parsePairingPayload(raw.trim());
        const transport = new TcpTransport({
          host: payload.host,
          port: payload.port,
        });
        const client = createTermLoopClient({ transport });
        let result;
        try {
          result = await client.claimPairing(
            payload,
            deviceName.trim() || "Mobile"
          );
        } finally {
          await client.close();
        }

        const existing = await findConnectionMetaByEndpoint(
          payload.host,
          payload.port
        );
        const saved = await upsertConnection({
          id: existing?.id,
          name:
            existing?.name ||
            result.server_name ||
            payload.server_name ||
            `${payload.host}`,
          host: payload.host,
          port: payload.port,
          deviceId: result.device_id,
          accessToken: result.access_token,
          serverName: result.server_name,
        });

        try {
          await openSession(saved);
          await markConnected(saved.id);
          router.replace("/connected");
        } catch (err) {
          Alert.alert(
            "Paired but couldn't connect",
            `${result.server_name || payload.server_name} saved. ` +
              `Open it from the connection list to retry.\n\n` +
              `Reason: ${(err as Error).message ?? err}`
          );
          router.replace("/");
        }
      } catch (err) {
        lastScanRef.current = null;
        Alert.alert("Pairing failed", friendlyTransportError(err));
      } finally {
        setBusy(false);
      }
    },
    [busy, deviceName, router]
  );

  const onBarcode = useCallback(
    ({ data }: { data: string }) => {
      if (lastScanRef.current === data) return;
      lastScanRef.current = data;
      claim(data);
    },
    [claim]
  );

  const permissionState = permissionToState(permission);

  return (
    <SafeAreaView style={styles.root} edges={["bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.viewfinder}>
            {permissionState === "granted" ? (
              <CameraView
                style={StyleSheet.absoluteFill}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={busy ? undefined : onBarcode}
              />
            ) : (
              <PermissionBox
                state={permissionState}
                onRequest={requestPermission}
              />
            )}
            {busy && (
              <View style={styles.busyOverlay}>
                <ActivityIndicator color="#fff" />
              </View>
            )}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Device name</Text>
            <TextInput
              style={styles.input}
              value={deviceName}
              onChangeText={setDeviceName}
              placeholder="iPhone"
              placeholderTextColor={colors.placeholder}
              autoCapitalize="words"
              autoCorrect={false}
            />
            <Text style={styles.hint}>
              Shown on your Mac so you can recognize this device.
            </Text>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Or paste payload</Text>
            <TextInput
              style={[styles.input, styles.textarea]}
              value={pasted}
              onChangeText={setPasted}
              placeholder='{"type":"termloop.pairing", ...}'
              placeholderTextColor={colors.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
            />
          </View>

          <Pressable
            style={[
              styles.primaryBtn,
              (busy || !pasted.trim()) && { opacity: 0.5 },
            ]}
            disabled={busy || !pasted.trim()}
            onPress={() => claim(pasted)}
          >
            <Text style={styles.primaryBtnText}>
              {busy ? "Pairing…" : "Pair from pasted payload"}
            </Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function PermissionBox({
  state,
  onRequest,
}: {
  state: Exclude<PermissionState, "granted">;
  onRequest: () => void;
}) {
  const message =
    state === "checking"
      ? "Checking camera permission…"
      : state === "prompt"
        ? "Camera access is required to scan pairing QR codes."
        : "Camera access denied. Enable it in Settings, or paste the payload below.";
  return (
    <View style={styles.permissionBox}>
      <Text style={styles.viewfinderText}>{message}</Text>
      {state === "prompt" && (
        <Pressable style={styles.permissionBtn} onPress={onRequest}>
          <Text style={styles.permissionBtnText}>Enable camera</Text>
        </Pressable>
      )}
    </View>
  );
}

function permissionToState(
  p: ReturnType<typeof useCameraPermissions>[0]
): PermissionState {
  if (p === null) return "checking";
  if (p.granted) return "granted";
  return p.canAskAgain ? "prompt" : "denied";
}

function defaultDeviceName(): string {
  return Platform.OS === "ios" ? "iPhone" : "Mobile";
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 16 },
  viewfinder: {
    height: 280,
    borderRadius: 12,
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  permissionBox: { paddingHorizontal: 16, alignItems: "center", gap: 12 },
  viewfinderText: { color: colors.label, fontSize: 13, textAlign: "center" },
  permissionBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: colors.primary,
  },
  permissionBtnText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  busyOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.overlay,
    alignItems: "center",
    justifyContent: "center",
  },
  section: { gap: 6 },
  sectionLabel: {
    color: colors.label,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  input: {
    backgroundColor: colors.inputBg,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    color: colors.text,
    fontSize: 14,
    borderWidth: 1,
    borderColor: colors.border,
  },
  textarea: { minHeight: 96, textAlignVertical: "top", fontFamily: monoFont },
  hint: { color: colors.hint, fontSize: 11 },
  primaryBtn: {
    marginTop: 8,
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: "center",
  },
  primaryBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});
