export const defaultSettings = {
  tankVolumeLiters: 300,
  heatingHoursPerDay: 3,
  priceDifferenceThresholdCents: 2,
  minTankTemperature: 20,
  maxTankTemperature: 80,
  showersAtMaxTemperature: 6,
} as const;

export type EnergiaZenSettings = typeof defaultSettings;
