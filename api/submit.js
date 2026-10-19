/**
 * Receive one session's data: called once per completed room (see
 * js/README.md's block table) and again with the full payload at session
 * end, so a child who disengages partway still has their earlier blocks
 * recorded server-side rather than only in a browser tab that may never save.
 *
 * Requires a ticket from verify-start.js (Authorization: Bearer <ticket>) --
 * Turnstile itself is solved only once, at session start; see _lib/ticket.js
 * for why.
 *
 *     Why Postgres, not Vercel Blob
 *     ------------------------------
 *     Blob's only access mode is "public": anyone with the (unguessable)
 *     URL can read it, no credential required. The payload carries a
 *     child's age, gender, ethnicity, race, handedness and first language --
 *     an IRB expects that behind real access control, not obscurity. Rows
 *     here are reachable only through this API, which is the only holder of
 *     POSTGRES_URL.
 *
 * Every call is an INSERT, never an UPDATE: each block's payload (which
 * already contains every response so far, not just that block's) lands as
 * its own row, so the row with the highest id for a participant is always
 * the most complete one available if the session never reaches "final".
 */
import { sql } from "@vercel/postgres";
import { verifyTicket } from "./_lib/ticket.js";
import { ensureSchema } from "./_lib/schema.js";
import { grantSonaCredit } from "./_lib/sona.js";

// Generous for 550 trials of small JSON rows, and still small enough that a
// forged/oversized body from a client that got past the ticket check cannot
// turn this into a storage-cost attack.
const MAX_BODY_BYTES = 5 * 1024 * 1024;

// How many rows one ticket may write while it is valid.
//
// This is the rate limit the platform will not do for us. The Vercel firewall
// rate-limits /api/verify-start (60/hour/IP), which caps how many tickets a
// client can mint -- but Hobby allows only that one rate-limiting rule, so
// there is none on this path, and a single ticket is otherwise good for three
// hours of unbounded INSERTs.
//
// The ceiling a real session needs is one row per completed room plus a final
// save: 51 for the longest plan (50 rooms), 23 for an adult. 200 leaves room
// for a child who restarts and replays under the same id, and still bounds
// what one stolen or scripted ticket can put in the table. The window matches
// the ticket's own lifetime, so it is a ceiling per ticket rather than a
// lifetime quota per participant -- a child coming back next week starts from
// zero, which a plain row count per participant_id would not allow.
const MAX_ROWS_PER_TICKET = 200;
const TICKET_WINDOW = "3 hours";   // _lib/ticket.js's TICKET_LIFETIME_MS

function tagFor(payload, block) {
  if (Number.isFinite(block)) return `block-${block}`;
  return payload?.participant_data?.completion_status === 1 ? "final" : "final_partial";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "POST only" });
    return;
  }

  // A missing SESSION_TICKET_SECRET makes verifyTicket THROW rather than
  // return false, and an uncaught throw here surfaces as
  // FUNCTION_INVOCATION_FAILED -- a bare 500 that reads like a database
  // problem when it is a one-line configuration one. Report it the same way
  // verify-start.js and export.js report their own missing secrets, so an
  // unconfigured deploy says which piece is missing instead of just falling
  // over.
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

  // The body IS the payload -- js/src/save.js's postPayload() sends the same
  // raw JSON any upload_url gets, unwrapped, so this endpoint isn't a special
  // case a generic collection endpoint would need to know about. The block
  // index (a per-block checkpoint vs. the final save) travels as a header
  // instead -- see postPayload's docstring for why it can't live in the body.
  const payload = req.body;
  const blockHeader = req.headers["x-session-block"];
  const block = blockHeader === undefined ? undefined : Number(blockHeader);
  if (!payload || typeof payload !== "object" || !payload.participant_data) {
    res.status(400).json({ ok: false, error: "expected a session payload" });
    return;
  }
  if (JSON.stringify(payload).length > MAX_BODY_BYTES) {
    res.status(413).json({ ok: false, error: "payload too large" });
    return;
  }

  // The ticket's pid is the authenticated identity; a payload claiming a
  // different participant_id would either be a bug or an attempt to write
  // into another child's record under a stolen/guessed ticket -- reject
  // rather than trust the body.
  const claimedPid = payload?.participant_data?.participant_id;
  if (claimedPid && claimedPid !== pid) {
    res.status(403).json({ ok: false, error: "payload/ticket participant mismatch" });
    return;
  }

  const tag = tagFor(payload, block);

  // Only the measurement is stored: the triplets and the demographics. The
  // game layer's own state -- stickers, placements, purchases, mini-game
  // scores -- stays in the file the experimenter downloads and is not kept
  // here, where nothing reads it (see js/src/save.js's forSubmission, which
  // already drops it client-side).
  //
  // Done again on this side because the client is not the authority on what
  // this table holds: a tab left open across a deploy, or a cached module,
  // still posts the old shape, and "we stopped sending it" is not the same
  // guarantee as "it is not stored".
  const stored = {
    participant_data: payload.participant_data,
    responses: payload.responses ?? [],
  };

  let id;
  try {
    await ensureSchema();

    // Counted before the insert, not after, so the cap is a ceiling rather
    // than a ceiling plus one. Indexed by sessions_participant_idx, which is
    // (participant_id, created_at DESC) -- exactly this query.
    const { rows: [{ recent }] } = await sql`
      SELECT count(*)::int AS recent FROM sessions
      WHERE participant_id = ${pid}
        AND created_at > now() - ${TICKET_WINDOW}::interval;
    `;
    if (recent >= MAX_ROWS_PER_TICKET) {
      // 429, not 403: this is a rate, and a client that backs off and returns
      // tomorrow is fine. Logged, because a REAL session hitting this means
      // the ceiling is wrong and someone's data is being dropped.
      console.warn(`upload cap reached for ${pid}: ${recent} rows in ${TICKET_WINDOW}`);
      res.status(429).json({ ok: false, error: "too many uploads for this session" });
      return;
    }

    const { rows } = await sql`
      INSERT INTO sessions (participant_id, tag, payload)
      VALUES (${pid}, ${tag}, ${JSON.stringify(stored)}::jsonb)
      RETURNING id;
    `;
    id = rows[0].id;
  } catch (e) {
    console.error("session insert failed", e);
    res.status(502).json({ ok: false, error: "storage unavailable" });
    return;
  }

  // Only after the row is committed: credit is what a stored session earns.
  // A failure here is reported as the credit's status, not as the upload's --
  // the data IS saved, and a 5xx would make the client retry a save that
  // already succeeded.
  let credit = null;
  try {
    credit = await grantSonaCredit({ pid, ticket, payload, tag, sessionRow: id });
  } catch (e) {
    console.error("SONA credit step failed", e);
    credit = "failed";
  }
  res.status(200).json({ ok: true, id, credit });
}
