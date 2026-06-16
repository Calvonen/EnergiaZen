import { createClient } from "@supabase/supabase-js";

const supabaseUrl = "https://amyvzelzbvjvrevikvrp.supabase.co";
const supabaseAnonKey = "sb_publishable_XTchn_mNxZwYWw06_Iphxw_IGYT44WV";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);