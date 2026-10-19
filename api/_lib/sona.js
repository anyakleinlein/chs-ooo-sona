/**
 * Grant a SONA participant's credit, server to server, once their completed
 * session is stored.
 *
 *     Why the server, not the browser
 *     -------------------------------
 *     SONA's "Client-Side Completion URL" carries the study's credit_token. A
 *     page that redirects there has to ship that URL to the browser, where
 *     anyone can read it out of config.js and credit themselves without
 *     running the study at all -- and the redirect happens whether or not the
 *     data ever arrived. The "Server-Side Completion URL" is the same call
 *     made from here instead: the token stays in an environment variable, and
 *     the call is only ever made AFTER submit.js has committed the final row.
 *     No stored data, no credit.
 *
 * SONA_CREDIT_URL is that Server-Side Completion URL from the study's SONA
 * page, pasted as-is with its literal XXXX:
 *
 *   https://<school>.sona-systems.com/services/SonaAPI.svc/WebstudyCredit
 *     ?experiment_id=123&credit_token=abc&survey_code=XXXX
 *
 * Credit is refused, and recorded as refused, unless every one of these holds:
 *   - the bot gate is on (TURNSTILE_SECRET_KEY set): an ungated deploy would
 *     hand credit to anything that can POST;
 *   - the payload is the FINAL save of a COMPLETED session, every planned
 *     trial answered;
 *   - its sona_id is the ticket's participant id, so a ticket cannot be used
 *     to credit someone else's code;
 *   - the session ran at least SONA_MIN_MINUTES (default 10) since admission,
 *     measured from the signed ticket rather than the browser's clock.
 *
 * Refusals return a status, never throw: the session row is already stored,
 * and the participant must be told what to do next rather than shown an
 * error that reads as "your data was lost".
 */
import { sql } from "@vercel/postgres";
import { ensureCreditsSchema } from "./schema.js";
import { ticketIssuedAt } from "./ticket.js";

const MIN_MINUTES = Number(process.env.SONA_MIN_MINUTES ?? 10);

// SONA answers in XML. Success is a Result whose credit_status is G; on
// failure the Errors element is populated instead. Namespace prefixes vary
// (a:credit_status), so the match ignores them.
const GRANTED = /<(?:\w+:)?credit_status>\s*G\s*</;

async function record(code, status, detail, sessionRow) {
  await sql`
    INSERT INTO sona_credits (survey_code, status, detail, session_row)
    VALUES (${code}, ${status}, ${detail}, ${sessionRow})
    ON CONFLICT (survey_code) DO UPDATE
      SET status = EXCLUDED.status,
          detail = EXCLUDED.detail,
          session_row = EXCLUDED.session_row,
          attempts = sona_credits.attempts + 1,
          updated_at = now();
  `;
}

/**
 * @returns {Promise<string|null>} null when this is not a SONA session's final
 *   save; otherwise "granted", "failed", "refused" or "not_configured".
 */
export async function grantSonaCredit({ pid, ticket, payload, tag, sessionRow }) {
  const pd = payload.participant_data;
  const code = pd.sona_id;
  if (!code || tag.startsWith("block-")) return null;

  await ensureCreditsSchema();

  const { rows: [prior] } = await sql`
    SELECT status FROM sona_credits WHERE survey_code = ${code};`;
  if (prior?.status === "granted") return "granted";

  const url = process.env.SONA_CREDIT_URL;
  if (!url || !url.includes("XXXX")) {
    await record(code, "not_configured", "SONA_CREDIT_URL is not set", sessionRow);
    return "not_configured";
  }

  const minutes = (Date.now() - ticketIssuedAt(ticket)) / 60000;
  const refusal =
    !process.env.TURNSTILE_SECRET_KEY ? "bot gate is off (TURNSTILE_SECRET_KEY unset)"
    : code !== pid ? "sona_id does not match the session ticket"
    : tag !== "final" || pd.completion_status !== 1 ? "session not completed"
    : !(pd.completed_regular_trials >= pd.planned_regular_trials
        && pd.planned_regular_trials > 0) ? "not every planned trial was answered"
    : minutes < MIN_MINUTES ? `session ran ${minutes.toFixed(1)} min, under ${MIN_MINUTES}`
    : null;
  if (refusal) {
    console.warn(`SONA credit refused for ${code}: ${refusal}`);
    await record(code, "refused", refusal, sessionRow);
    return "refused";
  }

  let body;
  try {
    const r = await fetch(url.replace("XXXX", encodeURIComponent(code)));
    body = await r.text();
  } catch (e) {
    console.error(`SONA credit call failed for ${code}`, e);
    await record(code, "failed", `unreachable: ${e.message}`, sessionRow);
    return "failed";
  }
  if (GRANTED.test(body)) {
    await record(code, "granted", null, sessionRow);
    return "granted";
  }
  console.error(`SONA did not grant credit for ${code}: ${body.slice(0, 500)}`);
  await record(code, "failed", body.slice(0, 2000), sessionRow);
  return "failed";
}
