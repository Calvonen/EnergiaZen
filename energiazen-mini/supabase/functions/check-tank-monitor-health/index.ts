import { createClient } from "npm:@supabase/supabase-js@2";

import {
  buildStaleReadingAlertEmail,
  computeReadingAgeMinutes,
  isReadingStale,
  shouldSendStaleAlert,
} from "./alertLogic.ts";

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };
const resendApiUrl = "https://api.resend.com/emails";
// Resendin oma testidomain - HUOM: tällä lähettäjällä Resend toimittaa
// viestejä vain sen tilin OMISTAJAN sähköpostiin (se osoite jolla Resend-tili
// luotiin), ei mihin tahansa osoitteeseen. Toimii nyt koska ainoa Supabase
// Auth -käyttäjä on sama henkilö. Jos appiin lisätään joskus toinen
// kirjautuva käyttäjä eri sähköpostilla, tämä pitää vaihtaa verifioituun
// omaan domainiin (ks. README.md) tai kyseinen käyttäjä ei koskaan saa
// hälytystä - Resend palauttaa silloin virheen eikä mitään lähde.
const alertFromAddress = "EnergyZen <onboarding@resend.dev>";
const monitorStateId = 1;
// supabase-js:n auth.admin.listUsers() palauttaa oletuksena vain
// ensimmäisen 50 käyttäjän sivun - fetchAllUserEmails käy kaikki sivut läpi
// jottei ketään unohdeta jos käyttäjiä on joskus enemmän.
const listUsersPageSize = 200;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { headers: jsonHeaders, status });
}

async function fetchAllUserEmails(
  supabase: ReturnType<typeof createClient>,
): Promise<string[]> {
  const emails: string[] = [];
  let page = 1;

  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: listUsersPageSize,
    });

    if (error) {
      throw error;
    }

    const users = data?.users ?? [];

    for (const user of users) {
      if (user.email) {
        emails.push(user.email);
      }
    }

    if (users.length < listUsersPageSize) {
      break;
    }

    page += 1;
  }

  return emails;
}

Deno.serve(async (request) => {
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const resendApiKey = Deno.env.get("RESEND_API_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse(
        { error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" },
        500,
      );
    }
    if (!resendApiKey) {
      return jsonResponse({ error: "Missing RESEND_API_KEY" }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const { data: readingRows, error: readingError } = await supabase
      .from("tank_readings")
      .select("created_at")
      .order("created_at", { ascending: false })
      .limit(1);

    if (readingError) {
      return jsonResponse({ error: readingError.message }, 502);
    }

    const latestReadingCreatedAt = readingRows?.[0]?.created_at ?? null;
    const nowIso = new Date().toISOString();
    const ageMinutes = computeReadingAgeMinutes(latestReadingCreatedAt, nowIso);
    const isStaleNow = isReadingStale(ageMinutes);

    const { data: stateRow, error: stateError } = await supabase
      .from("device_monitor_state")
      .select("is_stale")
      .eq("id", monitorStateId)
      .single();

    if (stateError) {
      return jsonResponse({ error: stateError.message }, 502);
    }

    const wasStale = stateRow?.is_stale === true;
    const shouldAlert = shouldSendStaleAlert({ isStaleNow, wasStale });
    let alertSent = false;

    if (shouldAlert) {
      let recipientEmails: string[];

      try {
        recipientEmails = await fetchAllUserEmails(supabase);
      } catch (error) {
        return jsonResponse(
          {
            error:
              error instanceof Error ? error.message : "Failed to list users",
          },
          502,
        );
      }

      if (recipientEmails.length > 0) {
        const email = buildStaleReadingAlertEmail({ ageMinutes });

        // Yksi viesti per vastaanottaja (ei kaikkia samaan to-kenttään) -
        // muuten jokainen käyttäjä näkisi kaikkien muidenkin
        // kirjautumissähköpostit vastaanottaja-otsikosta.
        for (const recipientEmail of recipientEmails) {
          const resendResponse = await fetch(resendApiUrl, {
            body: JSON.stringify({
              from: alertFromAddress,
              html: email.html,
              subject: email.subject,
              to: [recipientEmail],
            }),
            headers: {
              Authorization: `Bearer ${resendApiKey}`,
              "Content-Type": "application/json",
            },
            method: "POST",
          });

          if (!resendResponse.ok) {
            const errorBody = await resendResponse.text();
            return jsonResponse(
              {
                error: "Resend request failed",
                resend_body: errorBody,
                resend_status: resendResponse.status,
              },
              502,
            );
          }
        }

        alertSent = true;
      }
    }

    const updatePayload: Record<string, unknown> = {
      is_stale: isStaleNow,
      updated_at: nowIso,
    };

    if (alertSent) {
      updatePayload.alert_sent_at = nowIso;
    }

    const { error: updateError } = await supabase
      .from("device_monitor_state")
      .update(updatePayload)
      .eq("id", monitorStateId);

    if (updateError) {
      return jsonResponse({ error: updateError.message }, 502);
    }

    return jsonResponse({
      age_minutes: ageMinutes,
      alert_sent: alertSent,
      is_stale: isStaleNow,
      was_stale: wasStale,
    });
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Unknown error" },
      500,
    );
  }
});
