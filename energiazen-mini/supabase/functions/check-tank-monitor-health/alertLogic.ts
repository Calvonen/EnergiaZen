// Pidä tämä kynnys synkassa energiazen-mini/lib/tankMonitorAlert.ts:n
// tankMonitorAlertThresholdMinutes-vakion kanssa - appi näyttää
// virhebannerin ja tämä Edge Function lähettää sähköpostihälytyksen
// samalla rajalla, jotta molemmat kertovat aina saman tilan käyttäjälle.
export const staleReadingAlertThresholdMinutes = 30;

export function computeReadingAgeMinutes(
  readingCreatedAt: string | null,
  nowIso: string,
): number | null {
  if (!readingCreatedAt) {
    return null;
  }

  const readingTime = new Date(readingCreatedAt).getTime();
  const now = new Date(nowIso).getTime();

  if (Number.isNaN(readingTime) || Number.isNaN(now)) {
    return null;
  }

  return (now - readingTime) / (60 * 1000);
}

export function isReadingStale(ageMinutes: number | null) {
  return (
    ageMinutes === null ||
    ageMinutes < 0 ||
    ageMinutes > staleReadingAlertThresholdMinutes
  );
}

// Sähköposti lähtee vain silloin kun tila siirtyy terveestä vanhentuneeksi -
// ei joka cron-ajolla niin kauan kuin vika on jo tiedossa, eikä myöskään
// erillistä palautumisilmoitusta (ks. lib/tankMonitorAlert.ts:n käyttö
// etusivun virhebannerissa - se kertoo palautumisesta reaaliaikaisesti).
export function shouldSendStaleAlert({
  isStaleNow,
  wasStale,
}: {
  isStaleNow: boolean;
  wasStale: boolean;
}) {
  return isStaleNow && !wasStale;
}

export type TankMonitorAlertEmail = {
  html: string;
  subject: string;
};

// Ei ota vastaanottajia kantaa ollenkaan - sisältö on sama kaikille, mutta
// jokainen lähetetään erikseen (ks. index.ts) ettei kukaan käyttäjä näe
// muiden sähköpostiosoitteita samassa to-kentässä.
export function buildStaleReadingAlertEmail({
  ageMinutes,
}: {
  ageMinutes: number | null;
}): TankMonitorAlertEmail {
  const ageText =
    ageMinutes === null
      ? "Mittausta ei löytynyt lainkaan"
      : `Tuorein mittaus on ${Math.round(ageMinutes)} minuuttia vanha`;

  return {
    html:
      "<p>Varaajan lämpötila-anturin data ei ole päivittynyt normaalisti.</p>" +
      `<p>${ageText}.</p>` +
      "<p>EnergyZen käyttää tänä aikana valittuja varatunteja lämmitykseen, " +
      "kunnes mittaus toimii jälleen.</p>",
    subject: "EnergyZen: varaajan mittaus ei toimi",
  };
}
