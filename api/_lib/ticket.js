/**
 * Session admission tickets.
 *
 * Cloudflare Turnstile tokens are single-use and expire in a few minutes --
 * fine for gating the START of a session, wrong for authorizing every
 * per-block upload across what can be an hour-plus session (see js/README.md,
 * "Every session runs 550 trials"). So Turnstile is only ever checked ONCE,
 * in verify-start.js, and success there mints a ticket: an HMAC-signed
 * {pid, exp} the browser then attaches to every submit.js call for the rest
 * of the session. This is the same shape as a short-lived signed JWT, just
 * without pulling in a JWT library for two fields.
 *
 * SESSION_TICKET_SECRET must be set as a Vercel environment variable (any
 * long random string) and never shipped to the client -- it is what makes a
 * ticket unforgeable. Rotating it invalidates every ticket issued so far,
 * which only matters for sessions in progress at the moment of rotation.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

// Long enough for one session (550 trials can run past an hour for young
// children -- see js/README.md's pacing table), short enough that a leaked
// ticket is not a standing credential.
export const TICKET_LIFETIME_MS = 3 * 60 * 60 * 1000; // 3 hours

function secret() {
  const s = process.env.SESSION_TICKET_SECRET;
  if (!s) throw new Error("SESSION_TICKET_SECRET is not set");
  return s;
}

function sign(body) {
  return createHmac("sha256", secret()).update(body).digest("base64url");
}

/** Mint a ticket for `pid`, valid for TICKET_LIFETIME_MS from now. */
export function issueTicket(pid) {
  const exp = Date.now() + TICKET_LIFETIME_MS;
  const body = `${pid}.${exp}`;
  return `${body}.${sign(body)}`;
}

/**
 * Verify a ticket and return its participant id, or null if it is missing,
 * malformed, expired, or forged. Signature comparison is constant-time --
 * a naive `===` here would leak the correct signature one byte at a time
 * through response-time differences.
 */
export function verifyTicket(ticket) {
  if (!ticket || typeof ticket !== "string") return null;
  const parts = ticket.split(".");
  if (parts.length !== 3) return null;
  const [pid, expStr, sig] = parts;
  const body = `${pid}.${expStr}`;
  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;
  return pid;
}

/**
 * When an already-VERIFIED ticket was issued, i.e. when its session was
 * admitted. Derived from the signed expiry, so it is as trustworthy as the
 * ticket itself -- which is what lets api/_lib/sona.js measure how long a
 * session actually ran without trusting the browser's clock.
 */
export function ticketIssuedAt(ticket) {
  return Number(ticket.split(".")[1]) - TICKET_LIFETIME_MS;
}
