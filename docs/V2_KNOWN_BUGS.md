# EnergyZen V2 — known bugs and mandatory fixes

This document records production findings that must be addressed by the V2 heating model. These are not V1 patch requests unless explicitly stated otherwise.

## V2-BUG-007 — Active heating loses delivered-energy state

**Priority:** P0 — mandatory before V2 release  
**Observed in production:** 2026-09-06

### Problem

V1 can become increasingly pessimistic while heating is physically active because the optimizer re-estimates the tank primarily from the instantaneous sensor/shower state and does not reliably carry forward the heat energy already delivered during the active heating block.

This can cause the optimizer to conclude that the safety reserve cannot be maintained even with the maximum allowed heating hours. Repeated runs then remain `optimizer_invalid`, preventing the authoritative plan from being revalidated. Once the backend plan trust window expires, Shelly correctly falls back and an already published future heating hour can be missed.

### Production incident

Settings at the time:

- `target_shower_reserve = 5`
- `safety_shower_reserve = 3`
- `automatic_max_heating_hours = 4`
- automatic mode
- learned heating gain

Previously validated authoritative plan:

- `2026-09-06 | [14,16]`

Later optimizer runs requested up to four hours but remained invalid with:

- `safety shower reserve would be violated`

The backend therefore stopped producing new valid validations. The last valid plan aged beyond the 90-minute trust window and Shelly moved to backup control. The planned 16:00 heating hour was consequently no longer trusted.

### Root cause to remove in V2

The optimizer must not treat the energy already delivered by an active heating block as if it disappears merely because the sensor-derived state has not yet reacted as expected. Stratification, sensor lag and post-heating thermal recovery can make instantaneous sensor/shower estimates temporarily pessimistic.

V2 must use a physical energy/thermal state as the calculation basis. Shower count is a presentation value, not the optimizer's state variable.

### Required V2 behaviour

1. Maintain an explicit tank energy/thermal state in kWh or equivalent physical units.
2. When heating starts, account for delivered heater energy continuously/monotonically in the model.
3. Carry committed and already delivered energy across optimizer reruns during an active block.
4. Model learned heater gain, post-heating/recovery gain, standing losses and water draws separately.
5. Sensor observations may correct the modeled state, but sensor lag alone must not erase known delivered heater energy.
6. Active heating must not make the modeled energy state more pessimistic without evidence of a real energy-removing event such as a water draw or a validated anomaly.
7. Safety and target decisions must be based on the physical energy/thermal forecast, not shower-count arithmetic.
8. Preserve the existing hard-lock/cooldown safety semantics: once a planned contiguous heating block starts it is locked, the following hour is blocked, and the top-temperature safety override remains available.

### Acceptance criteria

- A replay of the 2026-09-06 incident does not enter a persistent `optimizer_invalid` state merely because sensor response lags during heating.
- Already delivered heater energy remains represented after every optimizer rerun.
- With no water draw or anomaly, an active heating interval cannot reduce the modeled stored-energy trajectory solely due to elapsed-time/sensor-lag effects.
- A valid published plan is not lost because the model forgets energy delivered earlier in the same heating block.
- Shower-count estimates may change independently for UI purposes without changing the optimizer's physical energy accounting.
- Regression tests cover stratification/sensor lag, active-block reruns, post-heating recovery and the 90-minute backend trust interaction.
