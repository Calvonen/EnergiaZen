import { StyleSheet, Text, View } from "react-native";

const currentPrice = 2.4;
const cheapPriceLimit = 5;
const expensivePriceLimit = 15;

function getPriceColor(price: number) {
  if (price <= cheapPriceLimit) {
    return "#7dff9b";
  }

  if (price >= expensivePriceLimit) {
    return "#ff8c7d";
  }

  return "#ffd27d";
}

export default function HomeScreen() {
  const ringColor = getPriceColor(currentPrice);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>⚡ EnergiaZen Mini</Text>

      <View style={[styles.ring, { borderColor: ringColor }]}>
        <Text style={[styles.decision, { color: ringColor }]}>LÄMMITÄ NYT</Text>
        <Text style={styles.price}>2,4</Text>
        <Text style={styles.unit}>c/kWh</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>🔥 Varaaja</Text>
        <Text style={styles.cardValue}>58 °C</Text>
      </View>

      <Text style={styles.info}>💧 Lämmin vesi riittää noin 17 h</Text>
      <Text style={styles.info}>🌙 Seuraava halpa jakso 01:00–05:00</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#050816",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  title: {
    color: "white",
    fontSize: 30,
    fontWeight: "900",
    marginBottom: 34,
  },
  ring: {
    width: 250,
    height: 250,
    borderRadius: 125,
    borderWidth: 5,
    alignItems: "center",
    justifyContent: "center",
    elevation: 20,
    marginBottom: 34,
  },
  decision: {
    fontSize: 22,
    fontWeight: "900",
    marginBottom: 14,
  },
  price: {
    color: "white",
    fontSize: 64,
    fontWeight: "900",
  },
  unit: {
    color: "#a6ffd0",
    fontSize: 18,
    marginTop: -4,
  },
  card: {
    backgroundColor: "rgba(255,255,255,0.08)",
    borderColor: "rgba(125,255,155,0.35)",
    borderWidth: 1,
    borderRadius: 22,
    padding: 20,
    width: "100%",
    marginBottom: 18,
  },
  cardTitle: {
    color: "#9cb8ff",
    fontSize: 16,
    fontWeight: "700",
  },
  cardValue: {
    color: "white",
    fontSize: 34,
    fontWeight: "900",
    marginTop: 6,
  },
  info: {
    color: "#c8d4ff",
    fontSize: 16,
    textAlign: "center",
    marginTop: 12,
  },
});
