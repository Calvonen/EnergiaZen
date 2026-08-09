export async function loadDashboardResources<TDashboard, TSettings, TLabel>({
  fetchDashboardData,
  fetchLabels,
  loadDashboardSettings,
  onLabelError,
}: {
  fetchDashboardData: () => Promise<TDashboard>;
  fetchLabels: () => Promise<TLabel[]>;
  loadDashboardSettings: () => Promise<TSettings>;
  onLabelError: (error: unknown) => void;
}) {
  return Promise.all([
    fetchDashboardData(),
    loadDashboardSettings(),
    fetchLabels().catch((error) => {
      onLabelError(error);
      return [] as TLabel[];
    }),
  ]);
}
