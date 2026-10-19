/**
 * The one table this study writes, created on demand.
 *
 * Shared by submit.js and export.js rather than owned by submit.js, because
 * "has the database been set up correctly" is a question you ask BEFORE any
 * session has ever run -- and the answer used to be a Postgres error saying
 * `relation "sessions" does not exist`, which reads as a broken database
 * rather than an empty one. With both endpoints creating it, an export
 * against a freshly connected database returns an empty list, which is the
 * honest answer and a usable health check.
 *
 * No separate migration step beyond setting POSTGRES_URL -- Vercel sets that
 * itself once a Postgres/Neon store is connected to the project.
 *
 * ONE STATEMENT PER CALL. `sql` from @vercel/postgres runs over Neon's
 * HTTP query endpoint, which speaks Postgres's extended (parameterized)
 * protocol -- and that protocol rejects a string holding more than one
 * command: `cannot insert multiple commands into a prepared statement`.
 * Sending the CREATE TABLE and the CREATE INDEX together therefore fails
 * every time, which surfaces as submit.js's 502 "storage unavailable" and
 * a database that never gets its table.
 */
import { sql } from "@vercel/postgres";

let schemaReady = null;

export function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS sessions (
          id SERIAL PRIMARY KEY,
          participant_id TEXT NOT NULL,
          tag TEXT NOT NULL,
          payload JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS sessions_participant_idx
          ON sessions (participant_id, created_at DESC);
      `;
    })().catch((e) => { schemaReady = null; throw e; }); // retry next call, don't wedge forever
  }
  return schemaReady;
}

let creditsReady = null;

/**
 * One row per SONA survey code: the outcome of granting that participant's
 * credit -- see api/_lib/sona.js, the only writer.
 *
 * It exists for two reasons. SONA's answer to a second grant for the same code
 * is undocumented, so a retried final upload must not ask twice: a code whose
 * row says "granted" is answered from here. And it is the researcher's record
 * of who was credited automatically and who still needs it done by hand,
 * readable through api/export.js?credits=1.
 */
export function ensureCreditsSchema() {
  if (!creditsReady) {
    creditsReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS sona_credits (
          survey_code TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          detail TEXT,
          session_row INTEGER,
          attempts INTEGER NOT NULL DEFAULT 1,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `;
    })().catch((e) => { creditsReady = null; throw e; });
  }
  return creditsReady;
}

let consentReady = null;

/**
 * The signed MELD consent/assent documents -- see api/consent.js, which is the
 * only writer, and its note on why these live in Postgres rather than Blob.
 *
 * A SEPARATE table from `sessions`, and created separately, for two reasons.
 * The obvious one is shape: this holds bytes, not JSON. The one that matters is
 * that `sessions` is what export.js hands out, and these documents must not
 * ride along with a response export -- keeping them in their own table means
 * including them takes a deliberate new query rather than a wider SELECT.
 *
 * UNIQUE (participant_id, form) is what consent.js's ON CONFLICT upserts
 * against: one current document per form per participant, so a session redone
 * after attaching the wrong file leaves one row rather than two with nothing to
 * distinguish them.
 *
 * Same one-statement-per-call rule as above -- see this file's header.
 */
export function ensureConsentSchema() {
  if (!consentReady) {
    consentReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS consent_files (
          id SERIAL PRIMARY KEY,
          participant_id TEXT NOT NULL,
          form TEXT NOT NULL,
          filename TEXT NOT NULL,
          mime TEXT NOT NULL,
          bytes INTEGER NOT NULL,
          content BYTEA NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `;
      await sql`
        CREATE UNIQUE INDEX IF NOT EXISTS consent_files_participant_form_idx
          ON consent_files (participant_id, form);
      `;
    })().catch((e) => { consentReady = null; throw e; });
  }
  return consentReady;
}
