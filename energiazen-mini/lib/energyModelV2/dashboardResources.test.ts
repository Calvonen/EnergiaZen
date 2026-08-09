import { loadDashboardResources } from "./dashboardResources";

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

export async function runDashboardResourcesUnitTests() {
  const labelError = new Error("No authenticated user");
  let reportedLabelError: unknown;
  const [dashboardData, settings, labels] = await loadDashboardResources({
    fetchDashboardData: async () => ({ diagnostics: "loaded" }),
    fetchLabels: async () => { throw labelError; },
    loadDashboardSettings: async () => ({ tank: "configured" }),
    onLabelError: (error) => { reportedLabelError = error; },
  });

  assert(dashboardData.diagnostics === "loaded", "label failure must not discard dashboard data");
  assert(settings.tank === "configured", "label failure must not discard settings");
  assert(labels.length === 0, "failed labels must fall back to an empty list");
  assert(reportedLabelError === labelError, "label failure must remain observable");

  const dashboardError = new Error("Dashboard unavailable");
  let rejectedWith: unknown;
  try {
    await loadDashboardResources({
      fetchDashboardData: async () => { throw dashboardError; },
      fetchLabels: async () => [],
      loadDashboardSettings: async () => ({}),
      onLabelError: () => undefined,
    });
  } catch (error) {
    rejectedWith = error;
  }
  assert(rejectedWith === dashboardError, "dashboard data failure must still reject the load");
}
