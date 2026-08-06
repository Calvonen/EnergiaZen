import { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

export type DashboardMetric = {
  label: string;
  tone?: "good" | "muted" | "warning";
  value: string;
};

export function DashboardCard({
  children,
  metrics,
  title,
}: {
  children?: ReactNode;
  metrics?: DashboardMetric[];
  title: string;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{title}</Text>
      {metrics?.map((metric) => (
        <View key={metric.label} style={styles.row}>
          <Text style={styles.label}>{metric.label}</Text>
          <Text style={[styles.value, metric.tone && styles[metric.tone]]}>
            {metric.value}
          </Text>
        </View>
      ))}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "rgba(255,255,255,0.07)",
    borderColor: "rgba(255,255,255,0.13)",
    borderRadius: 20,
    borderWidth: 1,
    overflow: "hidden",
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  title: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "900",
    letterSpacing: 0.4,
    marginBottom: 8,
  },
  row: {
    alignItems: "center",
    borderTopColor: "rgba(255,255,255,0.08)",
    borderTopWidth: 1,
    flexDirection: "row",
    gap: 12,
    minHeight: 48,
  },
  label: { color: "#9fb0d2", flex: 1, fontSize: 13, fontWeight: "700" },
  value: { color: "#eaf1ff", fontSize: 13, fontWeight: "900", textAlign: "right" },
  good: { color: "#54eaa0" },
  muted: { color: "#7889aa" },
  warning: { color: "#ffcf70" },
});
