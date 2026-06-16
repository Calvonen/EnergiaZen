import AsyncStorage from "@react-native-async-storage/async-storage";

type AuthUser = {
  email?: string | null;
};

type AuthSession = {
  user?: AuthUser | null;
} | null;

type AuthChangeCallback = (event: string, session: AuthSession) => void;

const authSessionStorageKey = "energiazen.supabase.session";
const authListeners = new Set<AuthChangeCallback>();

async function readStoredSession() {
  const storedSession = await AsyncStorage.getItem(authSessionStorageKey);

  if (!storedSession) {
    return null;
  }

  try {
    return JSON.parse(storedSession) as AuthSession;
  } catch {
    await AsyncStorage.removeItem(authSessionStorageKey);
    return null;
  }
}

function notifyAuthListeners(event: string, session: AuthSession) {
  authListeners.forEach((listener) => listener(event, session));
}

export const supabase = {
  auth: {
    async getSession() {
      return {
        data: {
          session: await readStoredSession(),
        },
        error: null,
      };
    },
    onAuthStateChange(callback: AuthChangeCallback) {
      authListeners.add(callback);

      return {
        data: {
          subscription: {
            unsubscribe: () => authListeners.delete(callback),
          },
        },
      };
    },
    async signOut() {
      await AsyncStorage.removeItem(authSessionStorageKey);
      notifyAuthListeners("SIGNED_OUT", null);

      return { error: null };
    },
  },
};

export type { AuthSession };
