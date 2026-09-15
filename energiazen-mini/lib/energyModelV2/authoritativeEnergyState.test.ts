import { createAuthoritativeEnergyState } from "./authoritativeEnergyState";
import { calculateTankStateFromObservation } from "./energyModelCore";
import { createPhysicalEnergyLedger } from "./physicalEnergyLedger";
import { sensorGeometryV2 } from "./sensorGeometry";
function assert(c:boolean,m:string){if(!c)throw new Error(m)}
function assertClose(a:number,e:number,m:string){if(Math.abs(a-e)>0.000001)throw new Error(`${m}: expected ${e}, got ${a}`)}
export function runAuthoritativeEnergyStateUnitTests(){
 const observed=calculateTankStateFromObservation({geometry:sensorGeometryV2,observation:{bottomTempC:25.8,heating:true,inletTempC:19.1,timestamp:"2026-09-08T11:20:55.000Z",topTempC:56.1}});
 const baseLedger=createPhysicalEnergyLedger({observedStoredEnergyKwh:observed.storedEnergy.kwh,timestamp:observed.timestamp??"2026-09-08T11:20:55.000Z"});
 const reconciled=createAuthoritativeEnergyState({ledger:{...baseLedger,modeledStoredEnergyKwh:baseLedger.observedStoredEnergyKwh+1,sensorCorrectionGapKwh:1},observedState:observed});
 assertClose(reconciled.uncertaintyKwh,0,"plain sensor lag is not physical balance uncertainty");
 const sensorOnly=createAuthoritativeEnergyState({ledger:baseLedger,observedState:{...observed,quality:"degraded",uncertainty:{...observed.uncertainty,energyKwh:0.1,reasons:["water-draw-or-mixing-corrected-from-sensors"]}}});
 assertClose(sensorOnly.uncertaintyKwh,0,"sensor correction generic uncertainty stays diagnostic only");
 const longGap=createAuthoritativeEnergyState({ledger:baseLedger,observedState:{...observed,quality:"degraded",uncertainty:{...observed.uncertainty,energyKwh:0.55,reasons:["water-draw-or-mixing-corrected-from-sensors","long-replay-gap"]}}});
 assertClose(longGap.uncertaintyKwh,0.55,"long-gap balance uncertainty remains fail-closed");
 const largeLag=createAuthoritativeEnergyState({ledger:{...baseLedger,modeledStoredEnergyKwh:baseLedger.observedStoredEnergyKwh+4.5,sensorCorrectionGapKwh:4.5},observedState:observed});
 assert(largeLag.quality==="degraded","large sensor lag degrades diagnostics only");
 assertClose(largeLag.uncertaintyKwh,0,"large sensor lag does not erase physical energy");
}
