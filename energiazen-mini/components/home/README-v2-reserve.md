# V2 home reserve presentation

The home warm-water card is presentation-only. It reads the latest V2 shadow reserve through `get_v2_energy_reserve_home()` and uses `conservative_energy_kwh / energy_capacity_kwh` for the displayed percentage. Safety and target markers come from the same V2 snapshot. It does not publish heating plans or change V1/Shelly control ownership.

When V2 is unavailable the card shows `--` rather than falling back to the legacy shower estimate, so the UI cannot imply that a V2 reserve is known when the shadow is fail-closed.
