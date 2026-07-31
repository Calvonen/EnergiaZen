import { isRecoveryDropEnabledForChannel } from "./recoveryDropEnvironment";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export function runRecoveryDropEnvironmentUnitTests() {
  assertEqual(
    isRecoveryDropEnabledForChannel("development"),
    true,
    "development-kanava on kaytossa",
  );
  assertEqual(
    isRecoveryDropEnabledForChannel("preview"),
    true,
    "preview-kanava on kaytossa",
  );
  assertEqual(
    isRecoveryDropEnabledForChannel("production"),
    false,
    "production-kanava pysyy pois paalta",
  );
  assertEqual(
    isRecoveryDropEnabledForChannel(null),
    false,
    "puuttuva kanava (esim. paikallinen expo start) pysyy pois paalta",
  );
  assertEqual(
    isRecoveryDropEnabledForChannel(undefined),
    false,
    "undefined-kanava pysyy pois paalta",
  );
  assertEqual(
    isRecoveryDropEnabledForChannel("jokin-tuntematon-kanava"),
    false,
    "tuntematon kanava pysyy pois paalta oletuksena (fail-closed)",
  );
}
