# V2 home reserve presentation

The home warm-water card is presentation-only. It reads the latest V2 shadow reserve through `get_v2_energy_reserve_home()` and uses `conservative_energy_kwh / energy_capacity_kwh` for the displayed percentage. Safety and target markers come from the same V2 snapshot. It does not publish heating plans or change V1/Shelly control ownership.

The presentation is fail-closed. When V2 is unavailable, the RPC/network refresh fails, or the latest `run_at` is older than 12 minutes, the card shows `--` rather than retaining a previous value or falling back to the legacy shower estimate. The 12-minute limit allows one missed five-minute shadow cadence plus margin while preventing an outage from presenting a frozen reserve as current.
