import { View, Text } from "react-native";
import { supabase } from "../lib/supabase";

export default function TestSupabase() {
  console.log("Supabase:", supabase);

  return (
    <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
      <Text>Supabase yhdistetty</Text>
    </View>
  );
}