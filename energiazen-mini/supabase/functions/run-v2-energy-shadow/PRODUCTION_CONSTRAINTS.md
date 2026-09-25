# V2 live-shadow production constraints

This shadow step carries the already-proven production anti-extension semantics into the V2 kWh planner without changing control ownership.

- Only stored `automatic` heating-plan hours can lock an active block.
- When the relay is actively heating, top temperature is at least 50 C, and the current hour belongs to the stored automatic plan, the current and remaining contiguous stored hours are required.
- The first chronological hour immediately after that locked block can be forbidden with `postHeatingBlockEnabled`; production currently sets this flag to `false`, so the optimizer may select the following hour.
- The separate no-new-mid-hour rule remains enabled: an already-started hour that was not committed before its boundary is forbidden. This is independent of the post-heating block flag.
- A stored consecutive current hour is exempt from cooldown.
- Below 50 C the block/cooldown constraints are released as the existing safety override.
- Fixed/manual plans are never imported as V2 automatic optimizer constraints.

This remains shadow-only. It does not write `heating_plans`, alter Shelly/controller code, or transfer production control from V1 to V2.
