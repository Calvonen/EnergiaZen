export type TemperatureHistoryPoint = {
  timestamp: string;
  topTemp: number;
  bottomTemp: number;
  heating: boolean;
};

const now = new Date();
const currentHour = new Date(now);
currentHour.setMinutes(0, 0, 0);

export const mockTemperatureHistory: TemperatureHistoryPoint[] = Array.from(
  { length: 25 },
  (_, index) => {
    const hoursAgo = 24 - index;
    const timestamp = new Date(
      currentHour.getTime() - hoursAgo * 60 * 60 * 1000,
    );
    const heating = [3, 4, 5, 15, 16, 22].includes(timestamp.getHours());
    const dayCurve = Math.sin((index / 24) * Math.PI * 2 - Math.PI / 2);
    const heatingBoost = heating ? 4.8 : 0;
    const coolingTrend = (24 - index) * 0.12;

    return {
      timestamp: timestamp.toISOString(),
      topTemp: Math.round((57 + dayCurve * 5 + heatingBoost - coolingTrend) * 10) / 10,
      bottomTemp:
        Math.round((43 + dayCurve * 3.5 + heatingBoost * 0.72 - coolingTrend) * 10) /
        10,
      heating,
    };
  },
);

export async function getTemperatureHistory() {
  return mockTemperatureHistory;
}
