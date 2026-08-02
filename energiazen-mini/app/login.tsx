import { useState } from "react";
import { View, Text, TextInput, Button, Alert } from "react-native";
import { useRouter } from "expo-router";
import { supabase } from "../lib/supabase";

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  async function signIn() {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      Alert.alert("Virhe", error.message);
      return;
    }

    router.replace("/");
  }

  return (
    <View
      style={{
        flex: 1,
        justifyContent: "center",
        padding: 20,
        gap: 12,
      }}
    >
      <Text style={{ fontSize: 28, fontWeight: "bold" }}>
        EnergyZen
      </Text>

      <TextInput
        placeholder="Sähköposti"
        autoCapitalize="none"
        value={email}
        onChangeText={setEmail}
        style={{
          borderWidth: 1,
          borderRadius: 10,
          padding: 12,
        }}
      />
      <Text style={{ color: "#666", fontSize: 12 }}>
        Sähköpostiosoitetta käytetään myös vikailmoitusten lähettämiseen.
      </Text>

      <TextInput
        placeholder="Salasana"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
        style={{
          borderWidth: 1,
          borderRadius: 10,
          padding: 12,
        }}
      />

      <Button title="Kirjaudu" onPress={signIn} />
    </View>
  );
}