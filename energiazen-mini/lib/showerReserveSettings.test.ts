import {
  getShowerReserveOptions,
  normalizeShowerReserves,
  normalizeStoredShowerReserves,
} from "./showerReserveSettings";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export function runShowerReserveSettingsUnitTests() {
  assertEqual(
    normalizeStoredShowerReserves({
      fullTankShowers: 6,
      minimumShowersBeforeExpensiveTomorrow: 3.5,
    }),
    { safetyShowerReserve: 2, targetShowerReserve: 3.5 },
    "vanha vahimmaisvaraus migroidaan tavoitevaraukseksi",
  );

  assertEqual(
    normalizeShowerReserves({
      fullTankShowers: 3,
      safetyShowerReserve: 4,
      targetShowerReserve: 5,
    }),
    { safetyShowerReserve: 2.5, targetShowerReserve: 3 },
    "tayden varaajan pienentaminen paivittaa rajat turvallisiksi",
  );

  assertEqual(
    getShowerReserveOptions({
      fullTankShowers: 6,
      safetyShowerReserve: 2,
      targetShowerReserve: 4,
      type: "target",
    }),
    [2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6],
    "tavoitevaihtoehdot noudattavat puolen suihkun askelta ja turvarajaa",
  );

  assertEqual(
    getShowerReserveOptions({
      fullTankShowers: 6,
      safetyShowerReserve: 2,
      targetShowerReserve: 4,
      type: "safety",
    }),
    [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
    "turvarajaksi ei tarjota tavoitteen suuruista arvoa",
  );
}
