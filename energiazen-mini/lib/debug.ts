export const DEV_LOGS = true;

export function debugLog(...args: unknown[]) {
  if (DEV_LOGS) {
    console.log(...args);
  }
}
