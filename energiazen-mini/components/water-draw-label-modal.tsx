import { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import {
  deleteWaterDrawLabel,
  saveWaterDrawLabel,
  type WaterDrawLabel,
  type WaterDrawLabelKind,
  type WaterDrawEventSnapshot,
  waterDrawLabelOptions,
} from "@/lib/energyModelV2/waterDrawLabels";

type Props = {
  event: WaterDrawEventSnapshot | null;
  label: WaterDrawLabel | null;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
};

export function WaterDrawLabelModal({ event, label, onChanged, onClose }: Props) {
  const [selection, setSelection] = useState<WaterDrawLabelKind>("unknown");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setSelection(label?.label ?? "unknown");
    setNote(label?.note ?? "");
    setError("");
  }, [event, label]);

  const run = async (action: () => Promise<unknown>) => {
    setSaving(true);
    setError("");
    try {
      await action();
      await onChanged();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Merkinnän tallennus epäonnistui.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet" transparent visible={Boolean(event)}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <Text style={styles.eyebrow}>KÄYTTÄJÄN GROUND TRUTH</Text>
            <Text style={styles.title}>Mitä vedenkäytössä tapahtui?</Text>
            {waterDrawLabelOptions.map((option) => (
              <Pressable key={option.label} accessibilityRole="radio" accessibilityState={{ checked: selection === option.label }}
                onPress={() => setSelection(option.label)} style={[styles.option, selection === option.label && styles.optionSelected]}>
                <Text style={styles.optionText}>{option.title}</Text>
              </Pressable>
            ))}
            <Text style={styles.inputLabel}>Lisätiedot (vapaaehtoinen)</Text>
            <TextInput multiline onChangeText={setNote} placeholder="Esim. naaman ja hampaiden pesu" placeholderTextColor="#657495"
              style={styles.input} value={note} />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            {saving ? <ActivityIndicator color="#36f4d4" /> : (
              <View style={styles.actions}>
                <Pressable onPress={onClose} style={styles.secondary}><Text style={styles.secondaryText}>Peruuta</Text></Pressable>
                <Pressable onPress={() => event && void run(() => saveWaterDrawLabel(event, selection, note))} style={styles.primary}>
                  <Text style={styles.primaryText}>Tallenna</Text>
                </Pressable>
              </View>
            )}
            {label && !saving ? (
              <Pressable onPress={() => event && void run(() => deleteWaterDrawLabel(event))} style={styles.deleteButton}>
                <Text style={styles.deleteText}>Poista merkintä</Text>
              </Pressable>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { backgroundColor: "rgba(0,0,0,0.65)", flex: 1, justifyContent: "flex-end" },
  sheet: { backgroundColor: "#0c1326", borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: "92%" },
  content: { padding: 22, paddingBottom: 36 },
  eyebrow: { color: "#36f4d4", fontSize: 11, fontWeight: "900", letterSpacing: 1.1 },
  title: { color: "#fff", fontSize: 21, fontWeight: "900", marginBottom: 18, marginTop: 5 },
  option: { borderColor: "rgba(255,255,255,0.13)", borderRadius: 12, borderWidth: 1, marginBottom: 8, padding: 14 },
  optionSelected: { backgroundColor: "rgba(54,244,212,0.12)", borderColor: "#36f4d4" },
  optionText: { color: "#eaf1ff", fontSize: 15, fontWeight: "800" },
  inputLabel: { color: "#b8c5df", fontSize: 13, fontWeight: "800", marginBottom: 7, marginTop: 12 },
  input: { borderColor: "rgba(255,255,255,0.18)", borderRadius: 12, borderWidth: 1, color: "#fff", minHeight: 80, padding: 12, textAlignVertical: "top" },
  actions: { flexDirection: "row", gap: 10, marginTop: 18 },
  primary: { alignItems: "center", backgroundColor: "#36f4d4", borderRadius: 12, flex: 1, padding: 14 },
  primaryText: { color: "#07111d", fontWeight: "900" },
  secondary: { alignItems: "center", borderColor: "rgba(255,255,255,0.2)", borderRadius: 12, borderWidth: 1, flex: 1, padding: 14 },
  secondaryText: { color: "#fff", fontWeight: "900" },
  deleteButton: { alignItems: "center", marginTop: 18, padding: 10 }, deleteText: { color: "#ff8d99", fontWeight: "800" },
  error: { color: "#ff8d99", fontSize: 12, marginTop: 10 },
});
