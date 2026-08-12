import {
  computeTankReadingAgeMinutes,
  isTankReadingStale,
  tankMonitorAlertThresholdMinutes,
} from "./tankMonitorAlert.ts";

// Kuinka vanha tank_readings-lukema saa enintään olla, jotta sitä käytetään
// suihkuarvioon, lämpötilaennusteeseen, automaattisen lämmitystarpeen
// laskentaan tai uuden heating_plans-suunnitelman julkaisemiseen. Sama raja
// kuin tankMonitorAlert.ts:n vikabannerissa - lukema joka jo laukaisisi
// bannerin ei ole myöskään luotettava laskentaan - mutta oma nimetty
// tarkoitus, jotta rajat voi jatkossa eriyttää tarvittaessa.
export const tankReadingCalculationMaxAgeMinutes = tankMonitorAlertThresholdMinutes;

// Käyttää samaa computeTankReadingAgeMinutes/isTankReadingStale-paria kuin
// vikabanneri, jotta "liian vanha laskentaan" ja "liian vanha ilman
// bannerin näyttämiseen" pysyvät aina samassa rajassa ilman erillistä
// ylläpidettävää kopiota.
export function isTankReadingFreshForCalculation(
  readingCreatedAt: string | null,
  now: Date,
): boolean {
  return !isTankReadingStale(
    computeTankReadingAgeMinutes(readingCreatedAt, now),
  );
}
