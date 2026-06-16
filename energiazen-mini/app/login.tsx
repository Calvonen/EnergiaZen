import { useState } from "react";
import { Alert, Button, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";

import { supabase } from "@/lib/supabase";

export default function LoginScreen() {
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
      <Text style={{ fontSize: 28, fontWeight: "bold" }}>EnergiaZen</Text>

      <TextInput
        autoCapitalize="none"
        keyboardType="email-address"
        onChangeText={setEmail}
        placeholder="Sähköposti"
        value={email}
        style={{
          borderWidth: 1,
          borderRadius: 10,
          padding: 12,
        }}
      />

      <TextInput
        onChangeText={setPassword}
        placeholder="Salasana"
        secureTextEntry
        value={password}
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
