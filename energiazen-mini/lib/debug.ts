export const DEV_LOGS = false;

export function debugLog(...args: unknown[]) {
  if (DEV_LOGS) {
    console.log(...args);
  }
}
