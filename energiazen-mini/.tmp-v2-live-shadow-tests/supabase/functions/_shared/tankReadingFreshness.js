"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tankReadingCalculationMaxAgeMinutes = void 0;
exports.isTankReadingFreshForCalculation = isTankReadingFreshForCalculation;
const tankMonitorAlert_ts_1 = require("./tankMonitorAlert.js");
// Kuinka vanha tank_readings-lukema saa enintään olla, jotta sitä käytetään
// suihkuarvioon, lämpötilaennusteeseen, automaattisen lämmitystarpeen
// laskentaan tai uuden heating_plans-suunnitelman julkaisemiseen. Sama raja
// kuin tankMonitorAlert.ts:n vikabannerissa - lukema joka jo laukaisisi
// bannerin ei ole myöskään luotettava laskentaan - mutta oma nimetty
// tarkoitus, jotta rajat voi jatkossa eriyttää tarvittaessa.
exports.tankReadingCalculationMaxAgeMinutes = tankMonitorAlert_ts_1.tankMonitorAlertThresholdMinutes;
// Käyttää samaa computeTankReadingAgeMinutes/isTankReadingStale-paria kuin
// vikabanneri, jotta "liian vanha laskentaan" ja "liian vanha ilman
// bannerin näyttämiseen" pysyvät aina samassa rajassa ilman erillistä
// ylläpidettävää kopiota.
function isTankReadingFreshForCalculation(readingCreatedAt, now) {
    return !(0, tankMonitorAlert_ts_1.isTankReadingStale)((0, tankMonitorAlert_ts_1.computeTankReadingAgeMinutes)(readingCreatedAt, now));
}
