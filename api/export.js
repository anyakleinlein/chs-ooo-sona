/**
 * Pull recorded sessions back out, for the researcher only -- not reachable
 * by a participant's browser and not part of the Turnstile/ticket flow at
 * all. Guarded by a SEPARATE secret (ADMIN_EXPORT_SECRET) so a leaked
 * session ticket (short-lived, scoped to one participant) can never be used
 * to read anyone else's data.
 *
 * Default: the single most-complete row per participant_id (highest id,
 * since submit.js's payload always contains every response so far, not just
 * one block's -- see submit.js's docstring). ?all=1 returns every row
 * instead, e.g. to inspect the block-by-block history for one participant.
 *
 * Usage:
 *   curl -H "Authorization: Bearer $ADMIN_EXPORT_SECRET" \
 *     "https://<deployment>/api/export" > sessions.json
 *
 * ?trials=1 returns the per-trial rows api/trial.js writes instead -- the
 * only record of a session that stopped inside a room. ?summary=1 returns one
 * line per participant joining all three tables: when they started, how far
 * they got, whether they finished, and what became of their SONA credit.
 *
 * Drop each row's `payload` into data/responses/ (named however
 * analysis/spose_comparison.py expects) to feed the existing pipeline --
 * this endpoint does not write local files itself, since a Vercel function
 * has no persistent disk to write them to.
 */
import { sql } from "@vercel/postgres";
import { ensureSchema, ensureCreditsSchema, ensureTrialsSchema } from "./_lib/schema.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "GET only" });
    return;
  }

  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const expected = process.env.ADMIN_EXPORT_SECRET;
  if (!expected) {
    console.error("ADMIN_EXPORT_SECRET is not set");
    res.status(500).json({ ok: false, error: "server not configured" });
    return;
  }
  if (!token || token !== expected) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  const pid = typeof req.query.participant_id === "string" ? req.query.participant_id : null;
  const all = req.query.all === "1";

  // The SONA credit ledger instead of sessions: who was credited
  // automatically, and who was refused or failed and needs it done by hand in
  // SONA. See api/_lib/sona.js.
  if (req.query.credits === "1") {
    try {
      await ensureCreditsSchema();
      const { rows } = pid
        ? await sql`SELECT * FROM sona_credits WHERE survey_code = ${pid};`
        : await sql`SELECT * FROM sona_credits ORDER BY updated_at DESC;`;
      res.status(200).json({ ok: true, count: rows.length, credits: rows });
    } catch (e) {
      console.error("credits export failed", e);
      res.status(502).json({ ok: false, error: "storage unavailable" });
    }
    return;
  }

  if (req.query.trials === "1") {
    try {
      await ensureTrialsSchema();
      const { rows } = pid
        ? await sql`SELECT * FROM trials WHERE participant_id = ${pid}
                    ORDER BY session_started, trial_index;`
        : await sql`SELECT * FROM trials
                    ORDER BY participant_id, session_started, trial_index;`;
      res.status(200).json({ ok: true, count: rows.length, trials: rows });
    } catch (e) {
      console.error("trials export failed", e);
      res.status(502).json({ ok: false, error: "storage unavailable" });
    }
    return;
  }

  // Who to credit by hand. A participant appears here if ANY table has heard
  // of them -- a start row alone (admitted, never answered a trial), trials
  // alone (sessions from before start rows existed), or both. `completed` is
  // a final save with completion_status 1, which is what submit.js tags
  // "final"; trials_saved counts every attempt, see `attempts`.
  if (req.query.summary === "1") {
    try {
      await ensureSchema();
      await ensureTrialsSchema();
      await ensureCreditsSchema();
      const { rows } = await sql`
        WITH s AS (
          SELECT participant_id,
                 max(payload->'participant_data'->>'sona_id') AS sona_id,
                 min(created_at) AS first_saved,
                 max(created_at) AS last_saved,
                 bool_or(tag = 'final') AS completed,
                 max((payload->'participant_data'->>'completed_regular_trials')::int)
                   AS regular_trials_in_saves,
                 max((payload->'participant_data'->>'planned_regular_trials')::int)
                   AS planned_regular_trials
          FROM sessions GROUP BY participant_id
        ), t AS (
          SELECT participant_id,
                 count(*)::int AS trials_saved,
                 count(DISTINCT session_started)::int AS attempts,
                 min(created_at) AS first_trial,
                 max(created_at) AS last_trial
          FROM trials GROUP BY participant_id
        )
        SELECT coalesce(s.participant_id, t.participant_id) AS participant_id,
               s.sona_id,
               least(s.first_saved, t.first_trial) AS started,
               greatest(s.last_saved, t.last_trial) AS last_activity,
               coalesce(s.completed, false) AS completed,
               coalesce(t.trials_saved, 0) AS trials_saved,
               coalesce(t.attempts, 0) AS attempts,
               s.regular_trials_in_saves,
               s.planned_regular_trials,
               c.status AS credit_status,
               c.detail AS credit_detail
        FROM s FULL OUTER JOIN t ON s.participant_id = t.participant_id
        LEFT JOIN sona_credits c
          ON c.survey_code = coalesce(s.participant_id, t.participant_id)
        ORDER BY started;
      `;
      res.status(200).json({ ok: true, count: rows.length, participants: rows });
    } catch (e) {
      console.error("summary export failed", e);
      res.status(502).json({ ok: false, error: "storage unavailable" });
    }
    return;
  }

  try {
    // Create the table if this database has never had a session written to
    // it. Without this, verifying a freshly connected database returns a
    // Postgres error about a missing relation, which looks like a broken
    // connection rather than an empty one.
    await ensureSchema();
    let rows;
    if (all) {
      ({ rows } = pid
        ? await sql`SELECT id, participant_id, tag, payload, created_at
                    FROM sessions WHERE participant_id = ${pid}
                    ORDER BY id ASC;`
        : await sql`SELECT id, participant_id, tag, payload, created_at
                    FROM sessions ORDER BY id ASC;`);
    } else {
      // DISTINCT ON + this ORDER BY is Postgres's "latest row per group" idiom:
      // one row per participant_id, the one with the highest id.
      ({ rows } = pid
        ? await sql`SELECT DISTINCT ON (participant_id)
                      id, participant_id, tag, payload, created_at
                    FROM sessions WHERE participant_id = ${pid}
                    ORDER BY participant_id, id DESC;`
        : await sql`SELECT DISTINCT ON (participant_id)
                      id, participant_id, tag, payload, created_at
                    FROM sessions
                    ORDER BY participant_id, id DESC;`);
    }
    res.status(200).json({ ok: true, count: rows.length, sessions: rows });
  } catch (e) {
    console.error("export query failed", e);
    res.status(502).json({ ok: false, error: "storage unavailable" });
  }
}
