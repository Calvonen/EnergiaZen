import { runPhysicalEnergyReplay } from "./physicalEnergyReplay";
import { sensorGeometryV2 } from "./sensorGeometry";
function assert(c:boolean,m:string){if(!c)throw new Error(m)}
function assertClose(a:number,e:number,m:string){if(Math.abs(a-e)>0.000001)throw new Error(`${m}: expected ${e}, got ${a}`)}
export function runAuthoritativeEnergyReplayUnitTests(){
 const replay=runPhysicalEnergyReplay({geometry:sensorGeometryV2,readings:[
  {bottomTempC:22.9,heating:true,inletTempC:19.4,timestamp:"2026-09-08T11:00:55.000Z",topTempC:56.2},
  {bottomTempC:25.8,heating:true,inletTempC:19.1,timestamp:"2026-09-08T11:20:55.000Z",topTempC:56.1},
  {bottomTempC:31.1,heating:true,inletTempC:19.4,timestamp:"2026-09-08T11:40:55.000Z",topTempC:56.1},
  {bottomTempC:36.2,heating:false,inletTempC:12.7,timestamp:"2026-09-08T12:00:55.000Z",topTempC:56.0},
 ]});
 assert(replay.finalLedger!==null,"replay produces ledger");assert(replay.finalAuthoritativeEnergy!==null,"replay produces authoritative energy");if(!replay.finalLedger||!replay.finalAuthoritativeEnergy)return;
 assertClose(replay.finalAuthoritativeEnergy.remainingEnergyKwh,replay.finalLedger.modeledStoredEnergyKwh,"authoritative remaining energy equals physical ledger");
 assertClose(replay.finalAuthoritativeEnergy.sensorGapKwh,Math.max(replay.finalLedger.modeledStoredEnergyKwh-replay.finalAuthoritativeEnergy.observedEnergyKwh,0),"sensor disagreement remains diagnostic");
 assert(replay.finalAuthoritativeEnergy.observedUsableEnergyKwh<=replay.finalAuthoritativeEnergy.observedEnergyKwh,"observed usable energy remains bounded");
 assert(!("showersLeft" in replay.finalAuthoritativeEnergy),"V2 authoritative state has no shower-count control field");
}
