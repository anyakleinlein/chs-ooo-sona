/**
 * Session configuration. Mirrors config/gamified_example.json so the same
 * knobs mean the same things in both builds.
 *
 * `Num Blocks` is how many ROOMS the castle has; `Num Trials` is trials per
 * room. Attention checks are added on top at ~10%.
 */

import { DURATIONS } from "./session.js";
export const CONFIG = {
  Tier: 1,
  participant_id: "WEB01",

  // Overwritten from the age-bin table unless ?rooms/?trials pin them --
  // see session.js. `Num Trials` is trials PER BLOCK, never the session total.
  "Num Blocks": 5,
  "Num Trials": 3,
  Session_Duration: "standard",   // short | standard | extended

  Age: "",
  Gender: "",
  Handedness: "",
  Ethnicity: "",
  // Race is a separate question from ethnicity, not a finer grain of it.
  // Race_Self_Describe is only ever non-empty when Race is
  // "Prefer to self-describe". Languages are free text: a fixed list would be
  // wrong for a multi-site study.
  Race: "",
  Race_Self_Describe: "",
  First_Language: "",
  Other_Languages: "",
  "Experiment Site": "",
  Setting: "lab",
  VR_Exposure: "",
  Screen_Time: "",

  // MELD consent/assent, set by consent.js's showConsentGate before a
  // session may proceed. See js/src/consent.js for the age bands.
  //
  // The gate is an ACKNOWLEDGEMENT: the participant opens each required form,
  // completes it, and ticks a box to confirm. The signed document itself lives
  // in REDCap, joined back to this session by participant_id (see
  // consentLinkUrl). The deploy also carries an endpoint that can receive the
  // documents directly (/api/consent) -- kept for a future version, and not
  // wired to anything here; see its docstring before switching it on.
  consent_forms_shown: [],
  consent_acknowledged: false,
  consent_acknowledged_at: null,

  Gamify: true,
  Gamify_Mascot: "neutral",
  Gamify_Reduced_Motion: false,
  // Silences the game's own sound effects. Reduced-motion mode implies it
  // unless the session says otherwise -- the same precedence GameLayer
  // applies on the desktop. Stimulus audio is never affected: a Tier 2 trial
  // without its clips is not the task.
  Gamify_Mute_SFX: false,

  // Where the finished session goes. Download is offered by default; set
  // upload_url to also POST the same JSON to a collection endpoint. The
  // public deploy points this at its own /api/submit -- the ONE line
  // utilities/export_public.py has to rewrite, so keep them together.
  upload_url: "/api/submit",

  // Public Turnstile SITE key for this deploy (not secret -- it is meant to
  // ship to the client; pairs with TURNSTILE_SECRET_KEY, set server-side
  // only, in Vercel's env vars). Blank runs every session ungated, which is
  // what a lab build with no backend wants -- see js/src/captcha.js. Get one
  // at https://dash.cloudflare.com/?to=/:account/turnstile.
  turnstile_site_key: "",

  // Dev/QA only -- added straight onto the spendable balance (never onto
  // castle.coins_awarded, which stays the response-blind, reproducible-
  // from-the-pid record every audit here relies on). Lets a tester open
  // the shop/mansion with money to spend without grinding real trials for
  // it. Set by ?bonus_coins=N, never anything a real participant session
  // would carry.
  Debug_Bonus_Coins: 0,

  // Children Helping Science, when this is running as a CHS *external* study.
  // CHS appends these two to the Study URL when a family presses "Participate
  // now" -- the hashed child id and the response id:
  //
  //   https://you.github.io/repo/js/index.html?child=SG7JLN&response=d5c8f502-...
  //
  // They are the only identity CHS hands over. Age and demographics are NOT
  // in the link; they live in the CHS demographic snapshot, joined on
  // chs_child afterwards. Recorded into participant_data so that join is
  // possible at all -- without them a session cannot be tied to a family.
  chs_child: null,
  chs_response: null,

  // SONA, when this is running as a SONA online external study. Set the
  // SONA Study URL to the deploy with %SURVEY_CODE% in it:
  //
  //   https://<project>.vercel.app/?sona=%SURVEY_CODE%
  //
  // SONA swaps in the participant's anonymous survey code, which becomes the
  // participant_id. Credit is granted by the SERVER once the final upload is
  // stored (api/_lib/sona.js) -- nothing here knows SONA's credit URL, because
  // anything in this file is readable by every participant.
  sona_id: null,

  // Whether the closing screen OFFERS a download button at all. Nothing
  // downloads automatically in any arm -- see save() in main.js -- so this no
  // longer suppresses a prompt, it decides whether there is a way to a local
  // file. Off under CHS, where a file on a parent's home computer is not a
  // data pipeline. Set by applyUrlOverrides, not by hand.
  offer_download: true,

  // True once ?rooms/?trials have actually PINNED the session length, so
  // main.js knows to leave it alone instead of overwriting it from the age-bin
  // table. Not the same as "the URL mentioned them": a value that was rejected
  // (unparseable, or a CHS session, where length is not negotiable) must fall
  // through to the plan rather than to whatever CONFIG happens to say here.
  session_length_pinned: false,

  // Tier 2 only. "shared" yokes the SAME triplets across the V/A/AV blocks,
  // which is what makes the AV vs (V + A) supradditivity contrast well
  // defined at item level; "disjoint" gives each block its own triplets and
  // supports group-level comparison only. Matches the desktop default (the
  // setup GUI writes "shared").
  Tier2_Triplet_Mode: "shared",

  // Stimulus pacing in the A/AV conditions, in ms. Defaults match the desktop
  // build: settle, then one sound every 3s.
  Audio_Lead_In_Ms: 800,
  Audio_Gap_Ms: 3000,

  // Resolved from THIS MODULE's own URL, not from the page's.
  //
  // A relative "../assets/game" is interpreted against the document, so it
  // depends on two things that vary: where index.html sits (js/index.html in
  // the lab checkout, the root in the deploy repo) and whether the site is
  // served from a domain root or a subpath. Those interact badly. On GitHub
  // *project* Pages the site lives under /<repo>/, so a page at the root
  // resolving "../datasets/..." escapes the project entirely and 404s -- which
  // is exactly what happened, and what a localhost test at a domain root
  // cannot reproduce.
  //
  // This module is always at <root>/js/src/config.js, so going up two levels
  // is the repository root wherever it is mounted and wherever the page sits.
  // Point `?media=` at another location on this origin to serve the media from
  // somewhere else.
  asset_root: new URL("../../assets/game", import.meta.url).href,
  dataset_root: new URL("../../datasets/Tier1_THINGS_560", import.meta.url).href,
  tier2_dataset_root: new URL("../../datasets/Tier2_AV_Matched", import.meta.url).href,
};

/**
 * Where the study is running, for the trust rules in applyUrlOverrides.
 *
 * A checkout served from a laptop is a workbench: every switch is meant to be
 * reachable, including the ones that hand a tester coins. A public deployment
 * is not — its URL is printed on a study page, and anyone can edit it before
 * they arrive.
 */
export function isDevHost(loc = globalThis.location) {
  const host = String(loc?.hostname ?? "");
  if (!host) return true;                       // file://, or a test harness
  return host === "localhost" || host === "127.0.0.1" || host === "::1"
    || host === "[::1]" || host.endsWith(".local");
}

/** A finite integer in [lo, hi], or null if it was not a usable number. */
function intIn(raw, lo, hi) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/** `raw` if it is one of `allowed`, else null. */
function oneOf(raw, allowed) {
  return allowed.includes(raw) ? raw : null;
}

/** `raw` trimmed to `max` characters, or null if empty. */
function text(raw, max = 64) {
  const s = String(raw ?? "").trim().slice(0, max);
  return s || null;
}

/**
 * `raw` if it points at THIS origin, else null.
 *
 * Guards the two parameters that name a location rather than a value:
 * `upload`, which decides where a child's responses are sent, and `media`,
 * which decides where the page loads its assets from. Left open, the first is
 * a one-parameter data leak -- the payload carries the child's age, gender,
 * ethnicity, race, handedness and first language -- and the second points the
 * study at someone else's files.
 *
 * A leading "//" is rejected before anything else: "//evil.example/x" looks
 * relative and is not, it is protocol-relative and resolves to another host.
 */
function sameOrigin(raw, loc) {
  const s = String(raw ?? "");
  if (!s || s.startsWith("//")) return null;
  try {
    const base = loc?.href || "http://localhost/";
    return new URL(s, base).origin === new URL(base).origin ? s : null;
  } catch {
    return null;
  }
}

/**
 * Read overrides from the query string: ?tier=2&pid=P07&rooms=6&trials=8&age=7
 *
 *     Every parameter is untrusted input
 *     ----------------------------------
 *     On a deployment this string is whatever the visitor typed. Three kinds
 *     of harm are possible and each is closed off here:
 *
 *     BREAKING the session -- `?rooms=abc` used to leave `Num Blocks` NaN and
 *     build a session with zero trials; `?rooms=20000` built 220,000 of them
 *     and locked the tab up for 19 seconds; `?age=abc` quietly ran a
 *     four-year-old through the adult plan. Numbers are now parsed and
 *     clamped, and words are matched against the list of values that mean
 *     something.
 *
 *     CHEATING it -- `?bonus_coins=` is a debug switch that hands out spending
 *     money, and `?rooms=1&trials=1` finishes the study in two taps. The first
 *     is now refused anywhere but a dev host; the second cannot touch a
 *     session that came from CHS.
 *
 *     REDIRECTING it -- see sameOrigin above.
 *
 *     A CHS session is not negotiable
 *     -------------------------------
 *     When CHS hands over a `child`, the identity, the length and the
 *     destination of that session are fixed. A family arriving with extra
 *     parameters bolted on gets the session the study intends: their own
 *     child hash (which seeds the sequence and is the join key back to the
 *     demographic snapshot), the length their age bin calls for, and this
 *     deploy's own endpoint.
 */
export function applyUrlOverrides(cfg, search = window.location.search,
                                  loc = globalThis.location) {
  const q = new URLSearchParams(search);
  const dev = isDevHost(loc);
  // Set below by the CHS branch. Locks the three things a real participant
  // must not be able to restate: who they are, how long they sit there, and
  // where the data goes.
  let chs = false;

  // CHS first, and it wins: `pid` no longer overrides the child hash.
  if (q.get("child")) {
    cfg.chs_child = q.get("child");
    cfg.chs_response = q.get("response") || null;
    // The child hash IS the participant id. It is stable per child, which is
    // what the age-bin analyses need to group by, and it seeds the triplets --
    // so a child who participates twice replays the SAME sequence. Seed from
    // chs_response instead if repeat sessions should cover new triplets.
    cfg.participant_id = q.get("child");
    // A parent at home should not be handed a JSON file, and should never see
    // the experimenter's form.
    cfg.offer_download = false;
    cfg.Setting = "home";
    chs = true;
  }

  // SONA's survey code goes into the credit URL and the page, so only the
  // characters SONA itself issues are accepted. It wins over ?pid= for the
  // same reason the CHS hash does: credit is granted against this id.
  //
  // A SONA session is locked like a CHS one -- a participant who could add
  // ?rooms=1&trials=1 would earn credit in two taps. The one exception is a
  // code starting TEST: SONA's own codes are numeric, so a TEST code can never
  // be credited, and a short smoke test of the whole SONA path is worth having.
  const sona = q.get("sona");
  let sonaLocked = false;
  if (!chs && sona && /^[A-Za-z0-9_-]{1,64}$/.test(sona)) {
    cfg.sona_id = sona;
    cfg.participant_id = sona;
    cfg.offer_download = false;
    cfg.Setting = "sona";
    sonaLocked = !/^TEST/i.test(sona);
  }
  const locked = chs || sonaLocked;

  // -- where things come from and go to: this origin only ------------------
  const media = sameOrigin(q.get("media"), loc);
  if (media) {
    const base = media.replace(/\/+$/, "");
    cfg.asset_root = `${base}/assets/game`;
    cfg.dataset_root = `${base}/datasets/Tier1_THINGS_560`;
    cfg.tier2_dataset_root = `${base}/datasets/Tier2_AV_Matched`;
  }
  // One rule for everyone, CHS included: same origin or ignored. Refusing it
  // outright for CHS was too strict -- it left those sessions with nowhere to
  // send data at all -- and bought nothing, since same-origin is where a CHS
  // session was already posting.
  const upload = sameOrigin(q.get("upload"), loc);
  if (upload) cfg.upload_url = upload;

  // -- the session's shape -------------------------------------------------
  // Fixed for a CHS family on a deployment: their age bin decides the length
  // (see main.js's sessionPlan call, which runs unless something pinned it).
  // Still settable on a dev host, because otherwise there is no way to walk
  // the CHS path in a two-room session -- which is exactly what the jsdom
  // harness does, and what anyone smoke-testing that path needs.
  if (!locked || dev) {
    // 64 is comfortably above anything sessionPlan produces (50 blocks of 78
    // for the longest plan) and far below the point where building the
    // timeline stops being instant.
    const rooms = intIn(q.get("rooms"), 1, 64);
    if (q.get("rooms") && rooms !== null) {
      cfg["Num Blocks"] = rooms;
      cfg.session_length_pinned = true;
    }
    const trials = intIn(q.get("trials"), 1, 64);
    if (q.get("trials") && trials !== null) {
      cfg["Num Trials"] = trials;
      cfg.session_length_pinned = true;
    }
    // The id seeds every draw in the session, and for a CHS family it is the
    // child hash -- the join key back to the demographic snapshot, which a
    // second id would break.
    const pid = text(q.get("pid"), 64);
    if (pid && !cfg.sona_id) cfg.participant_id = pid;
  }

  // -- what the study IS ---------------------------------------------------
  //
  // Same rule as the session's shape above, and for a stronger reason: these
  // decide which arm and which task the child is in. `plain=1` moves them
  // into the non-gamified baseline arm, `tier=2` gives them a different
  // experiment entirely, and `age` is what the analyses bin by.
  //
  // A CHS study URL and a CHS family's URL are the SAME string -- CHS appends
  // `child`/`response` to whatever the researcher configured, and the family
  // sees the result in their address bar. So there is no way to honour the
  // researcher's `?tier=2` on a deployment without also honouring a visitor's
  // edit of it. The public study therefore runs the ONE configuration
  // committed in CONFIG above: change the arm by editing that and deploying,
  // which is the same reasoning that took the gamified / reduced-motion
  // checkboxes off the public setup form (utilities/export_public.py).
  //
  // Everything stays settable on a dev host, or the CHS path could only ever
  // be smoke-tested in whatever tier CONFIG happens to name.
  const studyConfigurable = !locked || dev;
  if (studyConfigurable) {
    if (q.get("tier")) cfg.Tier = Number(q.get("tier")) === 2 ? 2 : 1;
    const mode = oneOf(q.get("mode"), ["disjoint", "shared"]);
    if (mode) cfg.Tier2_Triplet_Mode = mode;
    const lead = intIn(q.get("lead"), 0, 10000);
    if (q.get("lead") && lead !== null) cfg.Audio_Lead_In_Ms = lead;
    const gap = intIn(q.get("gap"), 100, 20000);
    if (q.get("gap") && gap !== null) cfg.Audio_Gap_Ms = gap;
    // A number, not "abc" -- an unparseable age used to fall through to the
    // adult bin, which is a 22-block session in front of a four-year-old.
    // For a CHS session it stays empty whatever the URL says, and is joined
    // from the demographic snapshot on chs_child afterwards.
    const age = intIn(q.get("age"), 1, 120);
    if (q.get("age") && age !== null) cfg.Age = String(age);
    const duration = oneOf(q.get("duration"), DURATIONS);
    if (duration) cfg.Session_Duration = duration;
    const site = text(q.get("site"), 64);
    if (site) cfg["Experiment Site"] = site;

    if (q.get("plain") === "1") cfg.Gamify = false;
    if (q.get("calm") === "1") cfg.Gamify_Reduced_Motion = true;
    if (q.get("quiet") === "1") cfg.Gamify_Mute_SFX = true;
  }

  // -- dev-host only -------------------------------------------------------
  // Spending money for a tester. Refused on a deployment however it is
  // spelled: it is the one parameter whose whole purpose is to skip the game.
  if (dev && q.get("bonus_coins")) {
    cfg.Debug_Bonus_Coins = intIn(q.get("bonus_coins"), 0, 1e6) ?? 0;
  }

  // Reduced stimulation implies quiet, unless this session asked for sound
  // explicitly. Mirrors GameLayer.__init__. An ignored ?quiet= is not an
  // answer either way -- otherwise a CHS URL could still speak here, through
  // the one parameter that was supposed to have been dropped.
  if (cfg.Gamify_Reduced_Motion && !(studyConfigurable && q.has("quiet"))) {
    cfg.Gamify_Mute_SFX = true;
  }
  return cfg;
}
