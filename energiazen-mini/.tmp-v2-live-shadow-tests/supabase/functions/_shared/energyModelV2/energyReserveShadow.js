"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.compareEnergyReserveShadow = compareEnergyReserveShadow;
/**
 * Compares V2's kWh-only reserve decision with the existing V1 energy-need
 * outcome. The caller supplies the V1 boolean explicitly so this module does
 * not import or perpetuate shower-count arithmetic.
 */
function compareEnergyReserveShadow({ v1NeedsEnergyRecovery, v2Decision, }) {
    const v2NeedsEnergyRecovery = v2Decision.needsEnergyRecovery;
    let classification;
    if (v2NeedsEnergyRecovery === null) {
        classification = "v2_unavailable";
    }
    else if (v2NeedsEnergyRecovery === v1NeedsEnergyRecovery) {
        classification = "agree";
    }
    else if (v2NeedsEnergyRecovery) {
        classification = "v2_more_conservative";
    }
    else {
        classification = "v2_less_conservative";
    }
    return {
        classification,
        conservativeEnergyKwh: v2Decision.conservativeEnergyKwh,
        v1NeedsEnergyRecovery,
        v2Band: v2Decision.band,
        v2NeedsEnergyRecovery,
    };
}
