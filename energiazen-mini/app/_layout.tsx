import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect, useState } from 'react';
import 'react-native-reanimated';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { SettingsScenarioProvider } from '@/lib/settingsScenarioContext';
import { supabase } from '@/lib/supabase';

export const unstable_settings = {
  anchor: '(tabs)',
};

// Every screen uses this dark background regardless of system color scheme.
// With edgeToEdgeEnabled the Android navigation bar is transparent, so
// without this the root view (and therefore the nav bar area) defaults to
// white instead of matching the app.
SystemUI.setBackgroundColorAsync('#050816');

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const router = useRouter();
  const segments = useSegments();
  const [isAuthReady, setIsAuthReady] = useState(false);

  useEffect(() => {
    let isMounted = true;

    const redirectIfNeeded = (hasSession: boolean) => {
      const isLoginRoute = segments[0] === 'login';

      if (hasSession && isLoginRoute) {
        router.replace('/');
      }

      if (!hasSession && !isLoginRoute) {
        router.replace('/login');
      }
    };

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (isMounted) {
        redirectIfNeeded(Boolean(session));
        setIsAuthReady(true);
      }
    });

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      redirectIfNeeded(Boolean(session));
      setIsAuthReady(true);
    });

    return () => {
      isMounted = false;
      authListener.subscription.unsubscribe();
    };
  }, [router, segments]);

  if (!isAuthReady) {
    return null;
  }

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <SettingsScenarioProvider>
        <Stack>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="settings" options={{ headerShown: false }} />
          <Stack.Screen name="login" options={{ headerShown: false }} />
          <Stack.Screen name="history" options={{ headerShown: false }} />
          <Stack.Screen
            name="electricity-history"
            options={{ headerShown: false }}
          />
          <Stack.Screen name="heating-learning" options={{ headerShown: false }} />
          <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
        </Stack>
        <StatusBar style="auto" />
      </SettingsScenarioProvider>
    </ThemeProvider>
  );
}
