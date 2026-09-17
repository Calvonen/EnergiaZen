import { strict as assert } from "node:assert";

import { buildV2PriceCeilingSettingTelemetry } from "./priceCeilingSetting.ts";

export function runV2PriceCeilingSettingUnitTests() {
  assert.deepEqual(buildV2PriceCeilingSettingTelemetry(null), {
    available: true,
    enabled: false,
    maxBilledPriceCentsPerKwh: null,
    reason: "disabled",
  });

  assert.deepEqual(buildV2PriceCeilingSettingTelemetry(undefined), {
    available: true,
    enabled: false,
    maxBilledPriceCentsPerKwh: null,
    reason: "disabled",
  });

  assert.deepEqual(buildV2PriceCeilingSettingTelemetry(25.5), {
    available: true,
    enabled: true,
    maxBilledPriceCentsPerKwh: 25.5,
    reason: "configured",
  });

  assert.deepEqual(buildV2PriceCeilingSettingTelemetry(-2), {
    available: true,
    enabled: true,
    maxBilledPriceCentsPerKwh: -2,
    reason: "configured",
  });

  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, "25", {}, []]) {
    const telemetry = buildV2PriceCeilingSettingTelemetry(invalid);
    assert.equal(telemetry.available, false);
    assert.equal(telemetry.enabled, false);
    assert.equal(telemetry.maxBilledPriceCentsPerKwh, null);
    assert.equal(telemetry.reason, "invalid_setting");
  }
}
