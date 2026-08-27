import { CONTRACT_IDENTITY } from "@termloop/contract/current";
import { useRouter } from "expo-router";
import { StyleSheet, Text, View } from "react-native";

import { PrimaryButton, SecondaryButton } from "@/components/primitives";
import {
  connectionBlockCopy,
  shortContractIdentity,
  type ConnectionBlock,
} from "@/presentation/connection-presentation";
import { color, space } from "@/theme/tokens";
import { fontFamily, text } from "@/theme/typography";

/// The blocking surface for a Mac this app cannot read.
///
/// It never offers "connect anyway". An app build that cannot decode the daemon's
/// exact current contract has nothing trustworthy to say about that Mac's state, and a
/// bypass would put a client with a stale idea of the wire in front of live work.
/// The stack is preserved underneath, so a resolved connection returns the user
/// exactly where they were.
export function ConnectionBlocked({ block, connectionName, contractIdentity, onRetry }: {
  block: ConnectionBlock;
  connectionName: string;
  contractIdentity: string | null;
  onRetry?: (() => void) | undefined;
}) {
  const router = useRouter();
  const copy = connectionBlockCopy(block);
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{copy.title}</Text>
      <Text style={styles.body}>{connectionName} — {copy.body}</Text>

      {block === "updateRequired" ? (
        <View style={styles.identities}>
          <IdentityRow label="This app" value={shortContractIdentity(CONTRACT_IDENTITY)} />
          <IdentityRow
            label="This Mac"
            value={contractIdentity === null ? "not reported" : shortContractIdentity(contractIdentity)}
          />
        </View>
      ) : null}

      <Text style={styles.resolution}>{copy.resolution}</Text>

      <View style={styles.actions}>
        {onRetry === undefined ? null : <PrimaryButton label="Retry" onPress={onRetry} />}
        <SecondaryButton label="Back to Macs" onPress={() => router.replace("/")} />
      </View>
    </View>
  );
}

function IdentityRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.identityRow}>
      <Text style={styles.identityLabel}>{label}</Text>
      <Text style={styles.identityValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: space.md,
    padding: space.xl,
  },
  title: { ...text.screenTitle, fontSize: 20, textAlign: "center" },
  body: {
    color: color.textSecondary,
    fontSize: 13,
    lineHeight: 20,
    textAlign: "center",
    maxWidth: 300,
  },
  identities: { alignSelf: "stretch", gap: 6, marginTop: space.xs },
  identityRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  identityLabel: { color: color.textMuted, fontSize: 12, width: 74 },
  identityValue: {
    flex: 1,
    color: color.textSecondary,
    fontFamily: fontFamily.mono,
    fontSize: 12,
  },
  resolution: {
    color: color.text,
    fontSize: 13,
    lineHeight: 20,
    textAlign: "center",
    maxWidth: 300,
  },
  actions: { alignSelf: "stretch", gap: space.xs, marginTop: space.sm },
});
