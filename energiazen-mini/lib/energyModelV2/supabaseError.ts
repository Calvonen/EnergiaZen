export type SupabaseErrorDetails = { code?: string; details?: string; hint?: string; message: string };

export function getSupabaseErrorDetails(caught: unknown): SupabaseErrorDetails | null {
  if (!caught || typeof caught !== "object") return null;
  const value = caught as Record<string, unknown>;
  if (typeof value.message !== "string" || !value.message) return null;
  return {
    message: value.message,
    ...(typeof value.code === "string" && value.code ? { code: value.code } : {}),
    ...(typeof value.details === "string" && value.details ? { details: value.details } : {}),
    ...(typeof value.hint === "string" && value.hint ? { hint: value.hint } : {}),
  };
}

export function waterDrawLabelErrorMessage(caught: unknown) {
  const details = getSupabaseErrorDetails(caught);
  if (details) return `${details.message}${details.code ? ` (${details.code})` : ""}`;
  return caught instanceof Error ? caught.message : "Merkinnän tallennus epäonnistui.";
}
