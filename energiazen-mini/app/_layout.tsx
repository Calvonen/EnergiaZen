import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import 'react-native-reanimated';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { supabase } from '@/lib/supabase';

export const unstable_settings = {
  anchor: '(tabs)',
};

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const router = useRouter();
  const segments = useSegments();

  useEffect(() => {
    let isMounted = true;

    const redirectIfNeeded = (isLoggedIn: boolean) => {
      const isLoginRoute = segments[0] === 'login';

      if (!isLoggedIn && !isLoginRoute) {
        router.replace('/login');
      }
    };

    supabase.auth.getUser().then(({ data }: { data: { user: { email?: string | null } | null } }) => {
      if (isMounted) {
        redirectIfNeeded(Boolean(data.user));
      }
    });

    const { data: authListener } = supabase.auth.onAuthStateChange((_event: string, session: { user?: unknown } | null) => {
      redirectIfNeeded(Boolean(session?.user));
    });

    return () => {
      isMounted = false;
      authListener.subscription.unsubscribe();
    };
  }, [router, segments]);

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="settings" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="history" options={{ headerShown: false }} />
        <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
      </Stack>
      <StatusBar style="auto" />
    </ThemeProvider>
  );
}
