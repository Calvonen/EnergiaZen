// EAS Update channels (see eas.json) where RecoveryDrop may run while it is
// still being validated. Anything not explicitly listed here - including an
// unrecognized or missing channel - stays disabled, so a production build
// only ever gets recoveryDropEnabled: true if "production" is added here on
// purpose.
export const recoveryDropEnabledChannels: readonly string[] = [
  "development",
  "preview",
];

export function isRecoveryDropEnabledForChannel(
  channel: string | null | undefined,
): boolean {
  if (!channel) {
    return false;
  }

  return recoveryDropEnabledChannels.includes(channel);
}
