import { useEffect, useState } from "react";
import { useRouter } from "expo-router";

import { AuthSession, supabase } from "@/lib/supabase";

export function useAuthRedirect() {
  const router = useRouter();
  const [session, setSession] = useState<AuthSession>(null);

  useEffect(() => {
    let isMounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!isMounted) {
        return;
      }

      setSession(data.session);

      if (!data.session) {
        router.replace("/login");
      }
    });

    const { data } = supabase.auth.onAuthStateChange((_event, updatedSession) => {
      setSession(updatedSession);

      if (!updatedSession) {
        router.replace("/login");
      }
    });

    return () => {
      isMounted = false;
      data.subscription.unsubscribe();
    };
  }, [router]);

  return session;
}
