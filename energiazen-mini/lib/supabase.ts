import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";

type SupabaseSessionStorage = {
  getItem: (key: string) => Promise<string | null>;
  removeItem: (key: string) => Promise<void>;
  setItem: (key: string, value: string) => Promise<void>;
};

const supabaseUrl = "https://amyvzelzbvjvrevikvrp.supabase.co";
const supabaseAnonKey = "sb_publishable_XTchn_mNxZwYWw06_Iphxw_IGYT44WV";
const sessionStorage = AsyncStorage as unknown as SupabaseSessionStorage;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    detectSessionInUrl: false,
    persistSession: true,
    storage: sessionStorage,
  },
});
