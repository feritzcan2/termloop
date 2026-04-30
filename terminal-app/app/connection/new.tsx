import React, { useEffect, useState } from 'react';
import {
  View, Text, TextInput, Pressable, StyleSheet, ScrollView, Alert,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Connection } from '../../lib/types';
import { createNewConnection, getConnection, saveConnection } from '../../lib/connections';
import {
  setTermLoopPassword,
  setSshPassword,
  getTermLoopPassword,
  getSshPassword,
} from '../../lib/secrets';

export default function NewOrEditConnection() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();

  const [conn, setConn] = useState<Connection>(() => createNewConnection());
  const [sshPw, setSshPw] = useState('');
  const [termloopPw, setTermLoopPw] = useState('');
  const [loading, setLoading] = useState(!!id);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      const existing = await getConnection(id);
      if (cancelled) return;
      if (!existing) {
        Alert.alert('Not found');
        router.back();
        return;
      }
      setConn(existing);
      setSshPw((await getSshPassword(id)) ?? '');
      setTermLoopPw((await getTermLoopPassword(id)) ?? '');
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [id]);

  function patch(p: Partial<Connection>) {
    setConn((c) => ({ ...c, ...p }));
  }
  function patchSsh(p: Partial<Connection['ssh']>) {
    setConn((c) => ({ ...c, ssh: { ...c.ssh, ...p } }));
  }
  function patchTermLoop(p: Partial<Connection['termloop']>) {
    setConn((c) => ({ ...c, termloop: { ...c.termloop, ...p } }));
  }

  async function onSave() {
    if (!conn.host.trim()) return Alert.alert('Host required');
    if (!conn.ssh.user.trim()) return Alert.alert('SSH user required');
    if (!sshPw) return Alert.alert('SSH password required');
    if (!termloopPw) return Alert.alert('TermLoop password required');
    const cleaned: Connection = { ...conn, incomplete: false };
    await saveConnection(cleaned);
    await setSshPassword(cleaned.id, sshPw);
    await setTermLoopPassword(cleaned.id, termloopPw);
    router.back();
  }

  if (loading) {
    return (
      <View style={styles.container}>
        <Text style={styles.label}>Loading…</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 40 }}>
      <Stack.Screen options={{ title: id ? 'Edit Connection' : 'New Connection' }} />

      <Text style={styles.label}>Label</Text>
      <TextInput
        style={styles.input}
        value={conn.label}
        onChangeText={(v) => patch({ label: v })}
        placeholder="My Mac"
        placeholderTextColor="#666"
      />

      <Text style={styles.label}>Host (Tailscale IP or hostname)</Text>
      <TextInput
        style={styles.input}
        value={conn.host}
        onChangeText={(v) => patch({ host: v })}
        placeholder="100.64.0.1"
        placeholderTextColor="#666"
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Text style={styles.section}>SSH</Text>

      <Text style={styles.label}>Port</Text>
      <TextInput
        style={styles.input}
        value={String(conn.ssh.port)}
        onChangeText={(v) => patchSsh({ port: parseInt(v, 10) || 0 })}
        keyboardType="numeric"
      />

      <Text style={styles.label}>User</Text>
      <TextInput
        style={styles.input}
        value={conn.ssh.user}
        onChangeText={(v) => patchSsh({ user: v })}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Text style={styles.label}>Password</Text>
      <TextInput
        style={styles.input}
        value={sshPw}
        onChangeText={setSshPw}
        secureTextEntry
      />

      <Text style={styles.section}>TermLoop</Text>

      <Text style={styles.label}>Port</Text>
      <TextInput
        style={styles.input}
        value={String(conn.termloop.port)}
        onChangeText={(v) => patchTermLoop({ port: parseInt(v, 10) || 0 })}
        keyboardType="numeric"
      />

      <Text style={styles.label}>Password</Text>
      <TextInput
        style={styles.input}
        value={termloopPw}
        onChangeText={setTermLoopPw}
        secureTextEntry
      />

      <Pressable style={styles.saveBtn} onPress={onSave}>
        <Text style={styles.saveBtnText}>{id ? 'Save changes' : 'Add connection'}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: '#1e1f29' },
  section: { color: '#bd93f9', fontSize: 18, fontWeight: '600', marginTop: 24, marginBottom: 4 },
  label: { color: '#f8f8f2', marginTop: 12, marginBottom: 4 },
  input: { backgroundColor: '#282a36', color: '#f8f8f2', padding: 10, borderRadius: 6 },
  saveBtn: { marginTop: 24, padding: 14, backgroundColor: '#50fa7b', borderRadius: 6, alignItems: 'center' },
  saveBtnText: { color: '#282a36', fontWeight: '700' },
});
