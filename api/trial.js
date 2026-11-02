/**
 * Store one answered triplet the moment it is answered.
 *
 * submit.js only hears from a session at the end of each room and at the end
 * of the session, so a participant who stops inside a room loses every answer
 * since the last room boundary -- and one who stops inside the FIRST room
 * leaves nothing behind at all. This is the per-trial save the desktop build
 * has always made (utilities/redcap_utils.py), and what the per-block rows
 * were standing in for.
 *
 * Same ticket as submit.js (Authorization: Bearer <ticket>); the ticket's pid
 * is the participant id, never the body. The body is one response row exactly
 * as js/src/save.js's makeResponse builds it -- the same shape as an entry of a
 * session payload's `responses`, so the two can be read side by side.
 *
 * Idempotent: a retried trial is answered 200 without a second row (see
 * ensureTrialsSchema for the key). That is what lets the client simply re-send
 * whatever failed, without having to know whether the first attempt landed.
 */
import { sql } from "@vercel/postgres";
import { verifyTicket, ticketIssuedAt } from "./_lib/ticket.js";
import { ensureTrialsSchema } from "./_lib/schema.js";

// A response row is a few hundred bytes. Anything near this is not one.
const MAX_BODY_BYTES = 16 * 1024;

// The cap on rows per session, enforced by the UNIQUE key instead of a count
// query: one row per trial_index, and trial_index must sit below this. The
// longest plan is 785 regular trials plus ~10% attention checks (js/src/
// session.js's "extended"), so 2000 is room to spare, and still bounds what
// one stolen or scripted ticket can write.
const MAX_TRIAL_INDEX = 2000;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "POST only" });
    return;
  }
  if (!process.env.SESSION_TICKET_SECRET) {
    console.error("SESSION_TICKET_SECRET is not set");
    res.status(500).json({ ok: false, error: "server not configured" });
    return;
  }

  const auth = req.headers.authorization || "";
  const ticket = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const pid = verifyTicket(ticket);
  if (!pid) {
    res.status(401).json({ ok: false, error: "missing or expired session ticket" });
    return;
  }

  const row = req.body;
  const idx = row?.trial_index;
  if (!row || typeof row !== "object" || !Number.isInteger(idx)
      || idx < 0 || idx >= MAX_TRIAL_INDEX) {
    res.status(400).json({ ok: false, error: "expected one response row" });
    return;
  }
  if (JSON.stringify(row).length > MAX_BODY_BYTES) {
    res.status(413).json({ ok: false, error: "payload too large" });
    return;
  }

  const started = new Date(ticketIssuedAt(ticket)).toISOString();
  try {
    await ensureTrialsSchema();
    await sql`
      INSERT INTO trials (participant_id, session_started, trial_index, response)
      VALUES (${pid}, ${started}, ${idx}, ${JSON.stringify(row)}::jsonb)
      ON CONFLICT (participant_id, session_started, trial_index) DO NOTHING;
    `;
  } catch (e) {
    console.error("trial insert failed", e);
    res.status(502).json({ ok: false, error: "storage unavailable" });
    return;
  }
  res.status(200).json({ ok: true });
}
