export type AutomaticModeReadiness = {
  owner: "v1" | "v2" | "conflict" | "unowned";
  ready: boolean;
  reason:
    | "ready_v1_rollback"
    | "ready_v2"
    | "dual_writer_conflict"
    | "v2_producer_inactive"
    | "no_automatic_owner";
  v1_optimizer_cron_active: boolean;
  v2_mirror_trigger_active: boolean;
  v2_producer_cron_active: boolean;
};

type AutomaticModeReadinessClient = {
  rpc: (
    name: "get_automatic_mode_readiness",
  ) => PromiseLike<{ data: unknown; error: unknown | null }>;
};

function isAutomaticModeReadiness(value: unknown): value is AutomaticModeReadiness {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<AutomaticModeReadiness>;
  return (
    typeof candidate.ready === "boolean" &&
    ["v1", "v2", "conflict", "unowned"].includes(String(candidate.owner)) &&
    [
      "ready_v1_rollback",
      "ready_v2",
      "dual_writer_conflict",
      "v2_producer_inactive",
      "no_automatic_owner",
    ].includes(String(candidate.reason)) &&
    typeof candidate.v1_optimizer_cron_active === "boolean" &&
    typeof candidate.v2_mirror_trigger_active === "boolean" &&
    typeof candidate.v2_producer_cron_active === "boolean"
  );
}

export async function fetchAutomaticModeReadiness(
  client: AutomaticModeReadinessClient,
) {
  const { data, error } = await client.rpc("get_automatic_mode_readiness");

  if (error) {
    throw error;
  }
  if (!isAutomaticModeReadiness(data)) {
    throw new Error("Automatic mode readiness payload is invalid");
  }

  return data;
}

export function getAutomaticModeReadinessMessage(
  readiness: AutomaticModeReadiness,
) {
  switch (readiness.reason) {
    case "dual_writer_conflict":
      return "Automaattiohjausta ei voi ottaa käyttöön, koska V1- ja V2-ohjaimet ovat yhtä aikaa aktiivisia.";
    case "v2_producer_inactive":
      return "Automaattiohjausta ei voi ottaa käyttöön, koska V2-suunnitelmien tuottaja ei ole käynnissä.";
    case "no_automatic_owner":
      return "Automaattiohjausta ei voi ottaa käyttöön, koska aktiivista automaattiohjainta ei ole.";
    default:
      return "";
  }
}
