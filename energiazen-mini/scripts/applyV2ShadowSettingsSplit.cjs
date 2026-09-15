const fs = require('fs');

const path = 'app/settings.tsx';
let text = fs.readFileSync(path, 'utf8');

const oldBlock = `      ...(showAutomaticSettings
        ? [{
        title: "Lämminvesivaraus",
        rows: [
          {
            accent: "#36f4d4",
            description:
              "V2 pyrkii pitämään varaajan fyysisestä energiakapasiteetista vähintään tämän osuuden. Prosentti on käyttäjän asetus; laskenta tehdään taustalla kWh-yksiköissä.",
            key: "v2TargetReservePercent",
            label: "Tavoitevaraus",
            secondaryValue: formatV2ReserveKwh(settings.v2TargetReservePercent),
            value: \`${'${settings.v2TargetReservePercent}'} %\`,
          },
          {
            accent: "#ffcf5a",
            description:
              "V2-ennusteen konservatiivinen energiamäärä ei saa laskea tämän osuuden alle. Jos raja uhkaa alittua, lämmitystä aikaistetaan hinnasta riippumatta.",
            key: "v2SafetyReservePercent",
            label: "Turvaraja",
            secondaryValue: formatV2ReserveKwh(settings.v2SafetyReservePercent),
            value: \`${'${settings.v2SafetyReservePercent}'} %\`,
          },
          {
            accent: "#54eaa0",
            description:
              "Optimointi voi käyttää enintään tämän määrän lämmitystunteja tarkasteluikkunan aikana. Todellinen tuntimäärä määräytyy varaajan ennusteen mukaan.",
            key: "automaticMaxHeatingHours",
            label: "Lämmitystuntien enimmäismäärä",
            value: \`${'${settings.automaticMaxHeatingHours}'} h\`,
          },
          {
            accent: "#ff7bd1",
            description:
              "Tämän toleranssin sisällä olevat hinnat käsitellään optimoinnissa samanarvoisina, jotta pieni hintaero ei yksin ratkaise lämmitystunnin valintaa. Näytetyt ja tallennetut hinnat pysyvät ennallaan.",
            key: "priceToleranceCents",
            label: "Hintatoleranssi",
            value: \`${'${settings.priceToleranceCents}'} snt/kWh\`,
          },
        ],
      } as SettingsSection]
        : [{`;

const newBlock = `      ...(showAutomaticSettings
        ? [
            {
              title: "Lämminvesivaraus",
              rows: [
                {
                  accent: "#36f4d4",
                  description:
                    "Nykyinen V1-ohjaus pyrkii pitämään käytettävissä yleensä vähintään tämän määrän suihkuja. Varaus voi hetkellisesti laskea tavoitteen alle, jos edullisia lämmitystunteja on tulossa.",
                  key: "targetShowerReserve",
                  label: "Tavoitevaraus suihkuina",
                  value: \`${'${settings.targetShowerReserve}'} suihkua\`,
                },
                {
                  accent: "#ffcf5a",
                  description:
                    "Nykyisen V1-ohjauksen ennustettu varaus ei saa laskea tämän alle. Jos raja uhkaa alittua, lämmitystä aikaistetaan hinnasta riippumatta.",
                  key: "safetyShowerReserve",
                  label: "Turvaraja suihkuina",
                  value: \`${'${settings.safetyShowerReserve}'} suihkua\`,
                },
                {
                  accent: "#54eaa0",
                  description:
                    "Optimointi voi käyttää enintään tämän määrän lämmitystunteja tarkasteluikkunan aikana. Todellinen tuntimäärä määräytyy varaajan ennusteen mukaan.",
                  key: "automaticMaxHeatingHours",
                  label: "Lämmitystuntien enimmäismäärä",
                  value: \`${'${settings.automaticMaxHeatingHours}'} h\`,
                },
                {
                  accent: "#ff7bd1",
                  description:
                    "Tämän toleranssin sisällä olevat hinnat käsitellään optimoinnissa samanarvoisina, jotta pieni hintaero ei yksin ratkaise lämmitystunnin valintaa. Näytetyt ja tallennetut hinnat pysyvät ennallaan.",
                  key: "priceToleranceCents",
                  label: "Hintatoleranssi",
                  value: \`${'${settings.priceToleranceCents}'} snt/kWh\`,
                },
              ],
            } as SettingsSection,
            {
              title: "V2 energiavaraus (shadow)",
              rows: [
                {
                  accent: "#36f4d4",
                  description:
                    "V2-shadow pyrkii pitämään varaajan mallinnetusta energiakapasiteetista vähintään tämän osuuden. Tämä asetus ei vielä ohjaa Shellyä.",
                  key: "v2TargetReservePercent",
                  label: "Tavoitevaraus",
                  secondaryValue: formatV2ReserveKwh(settings.v2TargetReservePercent),
                  value: \`${'${settings.v2TargetReservePercent}'} %\`,
                },
                {
                  accent: "#ffcf5a",
                  description:
                    "V2-shadown konservatiivinen energiamäärä ei saa laskea tämän osuuden alle. Tämä asetus vaikuttaa vain rinnakkaiseen V2-laskentaan.",
                  key: "v2SafetyReservePercent",
                  label: "Turvaraja",
                  secondaryValue: formatV2ReserveKwh(settings.v2SafetyReservePercent),
                  value: \`${'${settings.v2SafetyReservePercent}'} %\`,
                },
              ],
            } as SettingsSection,
          ]
        : [{`;

if (!text.includes(oldBlock)) {
  if (text.includes('title: "V2 energiavaraus (shadow)"')) {
    console.log('V2 shadow settings split already applied');
    process.exit(0);
  }
  throw new Error('Expected automatic settings block not found');
}

text = text.replace(oldBlock, newBlock);
text = text.replace(
  'summary: settings.v2TargetReservePercent + " % tavoite • " + settings.v2SafetyReservePercent + " % turvaraja",',
  'summary: getWarmWaterReserveSummary(settings),',
);

fs.writeFileSync(path, text);
