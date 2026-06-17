import { createClient } from "@supabase/supabase-js";
import { Platform } from "react-native";

type SupabaseSessionStorage = {
  getItem: (key: string) => Promise<string | null>;
  removeItem: (key: string) => Promise<void>;
  setItem: (key: string, value: string) => Promise<void>;
};

const supabaseUrl = "https://amyvzelzbvjvrevikvrp.supabase.co";
const supabaseAnonKey = "sb_publishable_XTchn_mNxZwYWw06_Iphxw_IGYT44WV";

const getNativeSessionStorage = (): SupabaseSessionStorage | undefined => {
  if (Platform.OS === "web") {
    return undefined;
  }

  const AsyncStorage = require("@react-native-async-storage/async-storage").default;

  return AsyncStorage as SupabaseSessionStorage;
};

const sessionStorage = getNativeSessionStorage();

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    detectSessionInUrl: false,
    persistSession: true,
    ...(sessionStorage ? { storage: sessionStorage } : {}),
  },
});
