/**
 * Drives a whole session in jsdom against the REAL jsPsych -- and, unlike the
 * first version of this harness, against the REAL src/main.js.
 *
 * That distinction earned itself immediately. The old harness re-implemented
 * main.js's timeline builder inside the test, so the two could drift, and they
 * did: the copy kept passing while the shipping code wrote jsPsych's global
 * timeline index into `trial_index` (5,6,7,11,12,13,... instead of 0..N-1),
 * because jsPsych reserves that field name and overwrites a plugin's value.
 * A harness that imports main.js cannot drift from main.js.
 *
 * Still not a substitute for opening the page: jsdom renders no pixels and
 * plays no audio.
 *
 *   node js/test/browser.mjs                 # both tiers, as subprocesses
 *   node js/test/browser.mjs "?tier=2&pid=X" # one session, in this process
 */
import { JSDOM, VirtualConsole } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

// ---------------------------------------------------------------------------
// No query given: run both tiers, each in its own process. main.js is a module
// with top-level side effects, so one process can only ever run one session.
// ---------------------------------------------------------------------------
if (!process.argv[2]) {
  let bad = 0;
  // Tier 2 runs at compressed pacing (lead=5, gap=20) so the harness does not
  // sit through 9.8s of playback per trial. The sequence still runs in full.
  for (const q of ["?pid=WEBTEST&rooms=2&trials=2",
                   "?tier=2&pid=WEBTEST2&rooms=3&trials=2&lead=5&gap=20",
                   // No pid: the experimenter's setup form must appear, and the
                   // session it produces must take its length from the plan
                   // rather than the config defaults. Rooms and trials are
                   // pinned only so the harness does not sit through all 550.
                   "?setup=1&age=5&duration=short&rooms=2&trials=2",
                   // A Children Helping Science external-study link: the family
                   // presses "Participate now" and CHS appends these two. No
                   // pid, and no form -- there is no experimenter at home.
                   // upload= stands in for the collection endpoint: with no
                   // download offered, the POST is the only way the data
                   // leaves the page, so the harness must exercise it.
                   "?child=SG7JLN&response=d5c8f502-6588-46c8-84fa-a9657a44fe47" +
                   "&rooms=2&trials=2&upload=http://localhost/collect"]) {
    console.log(`\n=================== ${q} ===================`);
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), q],
                        { stdio: "inherit" });
    if (r.status !== 0) bad++;
  }
  process.exit(bad ? 1 : 0);
}

const QUERY = process.argv[2];
const TIER2 = new URLSearchParams(QUERY).get("tier") === "2";
// A CHS link carries no pid either, but must NOT raise the form: the identity
// comes from `child` and there is no experimenter to fill anything in. Keying
// this off the missing pid alone left the harness waiting for a form that
// correctly never appeared, and the session never started.
const CHS = Boolean(new URLSearchParams(QUERY).get("child"));
// A SONA link also has no pid and DOES raise the form -- the participant's own
// version of it -- and, with a TEST code pinning the length, is the one
// form-driven session short enough to drive to the end. Run it as
// `?sona=TEST42&rooms=2&trials=2`.
const SONA = Boolean(new URLSearchParams(QUERY).get("sona"));
const SETUP = !new URLSearchParams(QUERY).get("pid") && !CHS && !SONA;

// jsdom has no navigation, so save.js's download anchor logs a "not
// implemented" every run. Drop only that; everything else still surfaces.
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => {
  if (!/Not implemented: navigation/.test(e.message)) console.error(e.message);
});
for (const level of ["log", "info", "warn", "error"]) vc.on(level, () => {});

const dom = new JSDOM(
  `<!doctype html><html><body><div id="jspsych-target"></div></body></html>`,
  { url: `http://localhost/js/index.html${QUERY}`,
    pretendToBeVisual: true, runScripts: "outside-only", virtualConsole: vc });

for (const k of ["window", "document", "navigator", "HTMLElement", "Element",
                 "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle",
                 "requestAnimationFrame", "cancelAnimationFrame", "DOMParser",
                 "HTMLMediaElement"]) {
  // defineProperty, not assignment: Node 21+ ships its own getter-only
  // `navigator`, which a plain assignment throws on.
  if (dom.window[k] !== undefined) {
    Object.defineProperty(globalThis, k, { value: dom.window[k],
                                           configurable: true, writable: true });
  }
}
// NOT dom.window.performance: jsdom's implementation looks the global up
// again, so aliasing it onto globalThis makes now() recurse into itself.

const errors = [];

// jsdom does not fetch images, so probeImages() would time out and every run
// would silently take the text-only cutscene fallback -- leaving CutscenePlugin
// untested. Report the panels as loadable so the real plugin runs.
globalThis.Image = class {
  set src(v) { this._src = v; setTimeout(() => this.onload && this.onload(), 0); }
  get src() { return this._src; }
};
dom.window.Image = globalThis.Image;

// jsdom has no media stack: play() is "not implemented" and would land in the
// error list as a false failure. Resolve it, and count the calls instead --
// which is itself worth asserting, since a Tier 2 session that plays no sounds
// is not a Tier 2 session.
let playCalls = 0;
globalThis.Audio = class extends dom.window.HTMLAudioElement {};
Object.defineProperty(dom.window, "Audio", {
  value: function Audio(src) {
    const el = dom.window.document.createElement("audio");
    if (src !== undefined) el.src = src;
    return el;
  },
  writable: true, configurable: true,
});
globalThis.Audio = dom.window.Audio;
dom.window.HTMLMediaElement.prototype.play = function () {
  if (!String(this.src).startsWith("data:")) playCalls++;
  return Promise.resolve();
};
dom.window.HTMLMediaElement.prototype.pause = function () {};
dom.window.HTMLMediaElement.prototype.load = function () {};

// Capture the payload save.js hands to the download, rather than writing it.
let savedJson = null;
// Any POST the session made to the deploy's consent endpoint -- see that branch
// in the fetch stub. Expected to stay EMPTY: the gate is a tick box and the
// endpoint is dormant, so anything landing here is a regression.
const consentUploads = [];
globalThis.Blob = class {
  constructor(parts) { this.__text = parts.join(""); }
};
dom.window.Blob = globalThis.Blob;
globalThis.URL.createObjectURL = (b) => { savedJson = b.__text; return "blob:stub"; };
globalThis.URL.revokeObjectURL = () => {};
// Browser globals jsdom does not hoist onto globalThis, bridged for the same
// reason Blob and createObjectURL are above. Nothing reads a file here now that
// the gate is a tick box, but these cost nothing and are what the document-
// upload path needed when it existed -- so re-enabling it does not start by
// rediscovering that its failure was being swallowed by a deliberately
// non-fatal catch while the session looked perfect.
globalThis.FileReader = dom.window.FileReader;
globalThis.File = dom.window.File;

// Serve the repo's files straight off disk.
globalThis.fetch = async (url, init) => {
  // A CHS session is never offered a download, so the POST to upload_url is
  // the only place its data appears. Capture it the way the Blob is captured
  // above, or the harness would be blind to exactly the path CHS relies on.
  if (init?.method === "POST") {
    // /api/verify-start is a POST and is NOT a session upload: it is the
    // ticket request js/src/captcha.js makes before the timeline is built.
    // Answering it here also exercises the Authorization header every later
    // upload carries. Falling through to the capture below instead set
    // savedJson on the first tick and ended the driving loop before a single
    // screen was clicked -- which reads as "no responses recorded", i.e. as
    // a broken build rather than a blind harness.
    if (String(url).includes("/api/verify-start")) {
      return { ok: true, status: 200,
               json: async () => ({ ok: true, gated: false, ticket: "harness-ticket" }) };
    }
    // The deploy's consent-document endpoint. Nothing in js/ calls it -- the
    // gate is a tick box and the signed form lives in REDCap -- so this branch
    // exists to CATCH a call rather than to serve one: the assertion below
    // requires consentUploads to stay empty. Kept because the endpoint itself
    // is kept (see api/consent.js), so if it is ever wired back up this stub
    // is already the right shape, and until then a stray POST is caught rather
    // than silently captured as the session payload.
    if (String(url).includes("/api/consent")) {
      const sent = JSON.parse(init.body || "{}");
      consentUploads.push({
        form: sent.form,
        bytes: (sent.content_base64 || "").length,
        auth: String(init.headers?.Authorization ?? ""),
      });
      return { ok: true, status: 200, json: async () => ({ ok: true, id: 1 }) };
    }
    // Per-block checkpoints (X-Session-Block header set -- see
    // js/src/save.js's postPayload) fire mid-session, one per completed
    // room; only the FINAL save -- from save(), never saveBlock() -- is
    // "the" payload the driving loop below should stop on. Capturing every
    // POST here would make it stop clicking after the first room -- exactly
    // the bug a real upload_url endpoint would hit if it treated a
    // checkpoint as the session being over. The block header is the actual
    // mechanism save.js/main.js use to tell the two apart (completion_status
    // alone can't: a disengaged session's FINAL save also carries
    // completion_status 0, same as every checkpoint), so this must stay in
    // sync with postPayload()'s header if a third POST type is ever added.
    const final = !("X-Session-Block" in (init.headers ?? {}));
    if (final) savedJson = init.body;
    // What api/submit.js answers a stored final save with. The closing screen
    // of a SONA session reads `credit` from it, so the stub has to say it.
    return { ok: true, status: 200,
             json: async () => (final ? { ok: true, id: 1, credit: "granted" } : {}) };
  }
  // config.js resolves the asset roots from its own module URL, which under
  // node is a file:// path -- so an absolute local path arrives here as often
  // as an http one. Map both back onto the repository.
  const raw = String(url);
  const file = raw.startsWith("file://")
    ? fileURLToPath(raw)
    : path.join(ROOT, raw.replace(/^https?:\/\/[^/]+\//, "").replace(/^\.\.\//, ""));
  if (!fs.existsSync(file)) {
    errors.push(`fetch 404: ${url} -> ${file}`);
    return { ok: false, status: 404, json: async () => ({}) };
  }
  const text = fs.readFileSync(file, "utf8");
  return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
};

dom.window.addEventListener("error", (e) => errors.push(`window error: ${e.message}`));
const origErr = console.error;
console.error = (...a) => { errors.push(`console.error: ${a.join(" ")}`); origErr(...a); };
const origWarn = console.warn;
const warnings = [];
console.warn = (...a) => { warnings.push(a.join(" ")); origWarn(...a); };

// Load the standalone build the way index.html does.
const jsPsychSrc = fs.readFileSync(
  path.join(HERE, "..", "vendor", "jspsych-8.2.1.browser.js"), "utf8");
dom.window.eval(jsPsychSrc);
globalThis.jsPsychModule = dom.window.jsPsychModule;
if (typeof globalThis.jsPsychModule?.initJsPsych !== "function") {
  console.error("jsPsych global missing"); process.exit(1);
}

// THE session. Everything above is scaffolding; this is the shipping code.
await import("../src/main.js");

// Drive it: click whatever the current screen offers, until a payload appears.
const target = dom.window.document.getElementById("jspsych-target");
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
// Tap-to-place: a pointerdown+pointerup pair with no movement between picks
// up the front of the tray and drops it where it landed (room_canvas.js's
// docstring: "Press-and-release without moving is the same code path" as a
// drag). Used now that the "Pip can do it" auto-arrange button is gone --
// this is the only way left to place a pending item at all.
// ":not(.empty)" -- the drawer always renders a minimum number of dashed
// placeholder slots now (room_canvas.js's MIN_SLOTS), which also match
// ".tray-item" and would otherwise make this loop about an always-full
// drawer that never actually empties. Queried from the OWNER DOCUMENT, not
// `room` itself -- the drawer is a sibling of the room below it now (see
// .room-wrap), not a child overlaying its bottom edge, so it is no longer
// inside `room`'s own subtree.
const placePending = (room) => {
  let n = 0;
  while (room.ownerDocument.querySelector(".tray-item:not(.empty)") && n++ < 50) {
    const opts = { clientX: 10, clientY: 10, bubbles: true };
    room.dispatchEvent(new dom.window.MouseEvent("pointerdown", opts));
    room.dispatchEvent(new dom.window.MouseEvent("pointerup", opts));
  }
};
let guard = 0;
let setupSeen = false;
let sonaForm = null;
let setupPreview = "";
// The MELD consent gate. 5 puts a CHS session in the 0-6 band, which is the
// TWO-form case (parental + 0-6 assent) -- the branch worth driving, since a
// single adult form would not catch a gate that only ever enables Continue on
// the first form it renders.
const CONSENT_AGE = 5;
let consentAgeAsked = false;
let consentFormsShown = 0;
let panelClicks = 0;   // cutscene panels are click-advanced, not button-advanced
// Stickers must be drawn from images, never as emoji text: the glyph would
// otherwise come from whatever emoji font the machine has, which is a tofu box
// on a Linux box with none installed. Sampled through the run because the
// playground and sticker book only exist on some screens.
let stickerImgs = 0;
let stickerTextOnly = 0;
// The mansion: what the driver did in there, asserted against the payload
// below. It walks one decoration room and one game room per visit, then
// leaves -- enough to prove every screen is reachable and that what happens
// in them is recorded.
let mansionVisits = 0;
let roomsEntered = 0;
// Whether the retrieve-to-pocket gesture (drag a placed item back down into
// the tray) was exercised, and whether it actually moved something back --
// see the "Pip can do it"-successor gesture in room_canvas.js's overTray().
let retrieveAttempted = false;
let retrieveWorked = false;
let arcadeRounds = 0;
let shopVisits = 0;
let shopPurchases = 0;
let bgPlacements = 0;
// Set if any shop cell's label/art literally reads "undefined" -- the exact
// bug a base-id/variant-id catalog mismatch produces (see js/src/main.js's
// furnitureItem). Checked live, not just in the saved payload, since a
// rendering bug can exist without corrupting what gets recorded. Labels
// render regardless of whether the item is affordable, so this is checked
// every visit even on a short session where nothing can be bought yet.
let shopUndefinedSeen = false;
// Whether an enabled (affordable, not-owned) buy button was ever seen -- a
// short test session may reach the shop before it can afford anything, in
// which case "nothing was bought" is correct, not a bug.
let shopAnyAffordable = false;
// Every driven case pins rooms/trials in its query, so this only has to cover
// a short session. A form-driven 550-trial run is not attempted -- jsdom did
// not finish one in eight minutes, and the loop just times out, which reads
// confusingly as "no responses recorded".
while (!savedJson && guard++ < 8000) {
  await new Promise((r) => setTimeout(r, 3));
  stickerImgs += target.querySelectorAll("img.sticker-art").length;
  for (const el of target.querySelectorAll(".sticker, .tray-item:not(.empty), .slot")) {
    if (!el.querySelector("img.sticker-art") && el.textContent.trim()) stickerTextOnly++;
  }
  const startBtn = target.querySelector("#s-start");
  if (startBtn) {
    // The setup screen owns the page until it is submitted.
    setupSeen = true;
    // What the form says it will run, before it runs it. The form derives this
    // from sessionPlan rather than the config defaults, and that derivation is
    // the property this case exists to check.
    setupPreview = (target.querySelector("#s-preview") ?? target).textContent;
    // A form-driven session cannot be driven to completion any more: the plan
    // is a flat 550 trials across 110 rooms, and jsdom did not finish one in
    // eight minutes. The handoff is asserted from the preview instead, and the
    // pid -> session path stays covered by the ?pid= cases above.
    if (SETUP) break;
    if (SONA) {
      sonaForm = {
        heading: target.querySelector("h1")?.textContent ?? "",
        pickers: Boolean(target.querySelector("#s-tier, #s-duration")),
      };
      target.querySelector("#s-age").value = "25";
    }
    click(startBtn);
    continue;
  }
  // -- the closing screen's download button ----------------------------------
  // Nothing downloads automatically any more (see save() in main.js), so on a
  // run with no upload_url this press is the ONLY thing that produces a
  // payload -- without it the loop below runs to its guard and reports "no
  // responses recorded" on a session that in fact completed perfectly. Pressed
  // last in the loop because it is the last thing on screen.
  const dl = target.querySelector("#download-data");
  if (dl) { click(dl); continue; }
  // -- the MELD consent/assent gate ------------------------------------------
  // Runs after the setup form and before the session, and BLOCKS both: without
  // this the harness sat on the consent screen until the guard expired and
  // reported "no responses recorded", which is what it did (in both repos, and
  // in production) from the moment the gate landed until this was added.
  //
  // Two screens, either of which can be the one showing. The age question
  // appears only when cfg.Age is still blank -- a CHS session, since CHS never
  // puts age in the URL; a ?age= session goes straight to the forms.
  const ageNext = target.querySelector("#c-age-next");
  if (ageNext) {
    const ageField = target.querySelector("#c-age");
    if (ageField) { ageField.value = String(CONSENT_AGE); consentAgeAsked = true; }
    click(ageNext);
    continue;
  }
  const consentContinue = target.querySelector("#c-continue");
  if (consentContinue) {
    consentFormsShown = target.querySelectorAll(".consent-links a").length;
    const ack = target.querySelector("#c-ack");
    // Checked by setting .checked AND firing change: the gate enables Continue
    // from the change handler, not from the property, so assigning alone would
    // leave the button disabled and the loop spinning.
    if (ack && !ack.checked) {
      ack.checked = true;
      ack.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    }
    if (!consentContinue.disabled) click(consentContinue);
    continue;
  }
  // -- the shop's background room-picker -------------------------------------
  // Reuses .mansion-grid for its tile layout, so it must be checked BEFORE
  // the real mansion grid below or a room CHOICE here reads as re-entering
  // the mansion.
  const picker = target.querySelector(".room-picker");
  if (picker) {
    bgPlacements++;
    click(picker.querySelector(".mansion-tile[data-room]") ?? picker.querySelector("#not-now"));
    continue;
  }
  // -- the mansion ----------------------------------------------------------
  // Its screens are a little state machine rather than a line of buttons, so
  // the generic "click whatever is offered" pass below cannot walk it.
  const grid = target.querySelector(".mansion-grid");
  if (grid) {
    mansionVisits++;
    const decorate = grid.querySelector(".mansion-tile[data-room]:not(.arcade)");
    const arcade = grid.querySelector(".mansion-tile.arcade[data-room]");
    if (roomsEntered === 0 && decorate) { roomsEntered++; click(decorate); }
    else if (arcadeRounds === 0 && arcade) { click(arcade); }
    else if (shopVisits === 0) { shopVisits++; click(target.querySelector("#shop")); }
    else click(target.querySelector("#leave"));
    continue;
  }
  // -- the shop, once entered ------------------------------------------------
  // A purchase announces itself with item_popup.js's popup OVER the
  // catalogue (see shop_view.js) rather than navigating to a "You got:"
  // reveal screen, so `.screen.shop` outside of a room-picker (handled
  // above) is always the catalogue. Buys everything affordable, one click
  // at a time so the DOM re-render between purchases (price/ownership
  // changing what's left enabled) is exercised for real, not just the
  // screen being reached.
  const shopScreen = target.querySelector(".screen.shop");
  if (shopScreen) {
    for (const el of shopScreen.querySelectorAll(".shop-row-label, .shop-row-art, .speech")) {
      if (el.textContent.includes("undefined")) shopUndefinedSeen = true;
    }
    const buyBtn = shopScreen.querySelector(".shop-buy:not([disabled])");
    if (buyBtn) { shopAnyAffordable = true; shopPurchases++; click(buyBtn); }
    else click(shopScreen.querySelector("#done"));
    continue;
  }
  const gameCanvas = target.querySelector("#game");
  if (gameCanvas) {
    // A whole round, driven through the game's own clock rather than 20
    // seconds of wall time -- and PLAYED, chasing whatever is on screen, so
    // the score and the coins it pays are exercised end to end rather than a
    // zero going through the motions.
    arcadeRounds++;
    const game = gameCanvas.__game;
    if (!game) continue;
    while (game.remainingMs > 0) {
      if (game._stars?.length) {
        game._basketX = game._stars.reduce((a, b) => (a.y > b.y ? a : b)).x;
      }
      if (game._sparkles?.length) {
        game._aimX = game._sparkles[0].x;
        game._aimY = game._sparkles[0].y;
      }
      game.tick(16);
      for (const b of [...(game._bubbles ?? [])]) game.onPointer({ x: b.x, y: b.y }, true);
      for (const f of [...(game._flies ?? [])]) game.onPointer({ x: f.x, y: f.y }, true);
    }
    continue;
  }
  if (target.querySelector("#again")) {          // the end-of-round panel
    click(target.querySelector("#back"));
    continue;
  }
  const backToMansion = target.querySelector("#back");
  if (backToMansion && target.querySelector(".room")) {
    const room = target.querySelector(".room");
    const tray = room.ownerDocument.querySelector(".tray");
    // jsdom reports a zero-size rect for every element (no layout engine),
    // which clamp()/radius() turn into NaN x/y for anything placed under
    // it -- fine for placePending's tap-to-place (position is never
    // checked), but the retrieve gesture below needs REAL x/y to compute
    // where the sticker it picks up actually is, and to hit-test against
    // the drawer's own rect (overTray() -- the drawer is a sibling BELOW
    // the room now, not an overlay inside it, see .room-wrap). Synthetic
    // rects stand in for both, room stacked directly above the drawer,
    // for exactly this room visit; the room_canvas.js math this feeds only
    // ever uses these as ratios/bounds, never real layout, so any
    // consistent non-zero sizes work.
    const origRoomRect = room.getBoundingClientRect.bind(room);
    const origTrayRect = tray.getBoundingClientRect.bind(tray);
    room.getBoundingClientRect = () => (
      { left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400 });
    tray.getBoundingClientRect = () => (
      { left: 0, top: 400, width: 400, height: 60, right: 400, bottom: 460 });
    placePending(room);  // place the pocket, by tap
    // Exercise the retrieve gesture once: pick a placed item back up and
    // drag it down into the tray, then place the pocket again (placePending
    // is idempotent once empty) so a short test session that only ever
    // earned one sticker still leaves the room decorated, same as the "a
    // room was decorated but nothing was placed" check below expects.
    if (!retrieveAttempted && room.querySelector(".sticker")) {
      retrieveAttempted = true;
      const before = room.ownerDocument.querySelectorAll(".tray-item:not(.empty)").length;
      const placedEl = room.querySelector(".sticker");
      const sx = (parseFloat(placedEl.style.left) || 0) / 100 * 400;
      const sy = (parseFloat(placedEl.style.top) || 0) / 100 * 400;
      room.dispatchEvent(new dom.window.MouseEvent(
        "pointerdown", { clientX: sx, clientY: sy, bubbles: true }));
      room.dispatchEvent(new dom.window.MouseEvent(
        "pointerup", { clientX: 200, clientY: 430, bubbles: true }));   // inside the mocked drawer rect
      retrieveWorked = room.ownerDocument.querySelectorAll(".tray-item:not(.empty)").length > before;
      placePending(room);   // put it back so the room stays decorated
    }
    room.getBoundingClientRect = origRoomRect;
    tray.getBoundingClientRect = origTrayRect;
    click(backToMansion);
    continue;
  }

  const scene = target.querySelector("#scene");
  const card = target.querySelector(".audio-card");
  const stim = target.querySelector(".stimulus");
  const room = target.querySelector(".room");
  const done = target.querySelector("#done");
  const go = target.querySelector("#go");
  // The cutscene advances on the scene itself, not a button. It also ignores
  // taps mid-fade, so this may need several passes per panel -- which is the
  // behaviour being checked.
  if (scene) { panelClicks++; click(scene); }
  else if (card) {
    // Answer only once the auto-play sequence has finished, the way a child
    // would. Clicking the instant the card appears is what let the first
    // version of this harness report a Tier 2 session that never played a
    // sound -- the trial ended before the lead-in timer even fired.
    const st = target.querySelector("#status")?.textContent ?? "";
    if (!/Pick one|Make your selection|Play it again|blocked/i.test(st)) continue;
    const pick = target.querySelector(".audio-card .pick");
    click(pick ?? card);
  }
  else if (stim) click(stim);
  // The standalone (pre-mansion) PlaygroundPlugin flow -- not reached by
  // the live game (the mansion's own .room case above handles it), kept
  // for whenever that plugin is used on its own again.
  else if (room && done) { placePending(room); click(done); }
  else if (done) click(done);
  else if (go) click(go);
}

const payload = savedJson ? JSON.parse(savedJson) : null;
// The closing screen's SONA line is written when the upload's response comes
// back, a tick after the POST this loop stops on.
await new Promise((r) => setTimeout(r, 50));
const sonaStatus = target.querySelector("#sona-status")?.textContent ?? "";
const rows = payload?.responses ?? [];

// --- assertions ------------------------------------------------------------
const fail = [];
const check = (ok, msg) => { if (!ok) fail.push(msg); };

// The bug this harness was rewritten to catch: trial_index must index the
// TRIAL list, exactly as the desktop build's does -- not jsPsych's timeline.
const idxs = rows.map((r) => r.trial_index);

// The setup case stops at the form and never runs a session, so everything
// that reads the payload applies only to the cases that do.
if (!SETUP) {
  check(payload !== null, "session never produced a payload");
  check(payload?.participant_data?.completion_status === 1, "session did not complete");
  check(rows.length > 0, "no responses recorded");
  check(JSON.stringify(idxs) === JSON.stringify([...idxs].sort((a, b) => a - b)),
        `trial_index not monotonic: ${idxs}`);
  check(idxs[0] === 0 && idxs[idxs.length - 1] === rows.length - 1,
        `trial_index is not 0..${rows.length - 1}: ${idxs}`);

  // The consent gate blocks every session, so reaching a payload at all proves
  // it was passed. What that does NOT prove is that it asked for anything --
  // a gate that rendered no forms and enabled Continue immediately would also
  // produce a payload. These check it actually gated.
  check(consentFormsShown > 0, "the consent gate showed no forms");
  // The gate is an acknowledgement, not an upload: the signed document lives in
  // REDCap. Nothing may be POSTed to the deploy's (dormant) consent endpoint,
  // and no document bytes may appear in the payload.
  check(consentUploads.length === 0,
        "a consent document was uploaded; the gate is meant to be a tick box");
  check(!JSON.stringify(payload).includes("%PDF"),
        "a consent document's bytes reached the session payload");
  check(payload?.participant_data?.consent_acknowledged === true,
        "consent_acknowledged did not reach the payload");
  check((payload?.participant_data?.consent_forms_shown ?? []).length > 0,
        "consent_forms_shown reached the payload empty");
  // Age 5 is a two-form band (parental + 0-6 assent). A gate that only
  // rendered the first form, or only required the first, would still pass
  // every check above.
  if (CHS) {
    check(consentAgeAsked, "a CHS session was not asked for an age");
    check(consentFormsShown === 2,
          `age ${CONSENT_AGE} should need 2 forms, gate showed ${consentFormsShown}`);
    // The age answered at the gate must become the session's age -- the gap
    // the gate was added to close, since a blank Age falls through to the
    // adult trial plan.
    // `age`, lowercase: save.js maps cfg.Age onto the desktop build's field
    // name, which is what analysis/vice_utils.py reads.
    check(String(payload?.participant_data?.age ?? "") === String(CONSENT_AGE),
          `the age given at the gate did not become the session's: `
          + `${payload?.participant_data?.age}`);
  }
}

if (TIER2) {
  const conds = rows.map((r) => r.condition);
  check(new Set(conds).size === 3, `expected all of V/A/AV, got ${[...new Set(conds)]}`);
  const blocks = rows.map((r) => r.block_number);
  check(JSON.stringify(blocks) === JSON.stringify([...blocks].sort((a, b) => a - b)),
        `blocks interleaved: ${blocks}`);
  // Every block runs exactly one condition.
  const perBlock = new Map();
  for (const r of rows) {
    if (perBlock.has(r.block_number)) check(perBlock.get(r.block_number) === r.condition,
                                            `block ${r.block_number} mixed conditions`);
    else perBlock.set(r.block_number, r.condition);
  }
  // Shared mode: the same triplets judged under every condition.
  const byCond = {};
  for (const r of rows.filter((x) => !x.is_attention_trial)) {
    (byCond[r.condition] ??= []).push([...r.concept_triplet].sort().join("|"));
  }
  const keys = Object.values(byCond).map((v) => v.slice().sort().join(","));
  check(new Set(keys).size === 1, "shared mode did not yoke triplets across conditions");
  check(playCalls > 0, "a Tier 2 session played no stimulus audio at all");
  check(rows.some((r) => r.condition !== "V" && "playback_ms" in r),
        "A/AV rows carry no playback_ms");
} else {
  check(rows.every((r) => r.condition === "V"), "Tier 1 produced a non-visual trial");
}

fs.writeFileSync(`/tmp/js_browser_session${TIER2 ? "_tier2" : ""}.json`,
                 JSON.stringify(payload, null, 2));

console.log("cutscene panel clicks :", panelClicks);
console.log("responses recorded    :", rows.length);
console.log("trial_index range     :", idxs.length ? `${idxs[0]}..${idxs[idxs.length - 1]}` : "-");
if (TIER2) {
  console.log("conditions            :", [...new Set(rows.map((r) => r.condition))].join(", "));
  console.log("block order           :", (payload?.game_state?.castle?.rooms ?? [])
    .map((r) => r.condition).join(" -> "));
  console.log("stimulus play() calls :", playCalls);
}
if (SETUP) {
  check(setupSeen, "no setup form appeared for a URL without a pid");
  // The form must plan from sessionPlan, not from the config defaults of
  // 5 rooms x 3 trials -- that is what this case has always been for. The
  // session is no longer driven to completion; see the break above.
  check(/550/.test(setupPreview),
        `the form did not plan the flat 550 trials: ${setupPreview.trim()}`);
  check(/11 per room × 50 rooms/.test(setupPreview),
        `the form did not plan 50 rooms of 11: ${setupPreview.trim()}`);
  check(!/3 per room × 5 rooms/.test(setupPreview),
        "the form fell back to the config defaults instead of the plan");
}
if (SONA) {
  check(sonaForm?.heading === "Before you begin",
        `the SONA form kept the experimenter's wording: ${sonaForm?.heading}`);
  check(sonaForm && !sonaForm.pickers,
        "the SONA form offers task/length pickers a participant could shorten");
  check(payload?.participant_data.sona_id === "TEST42",
        `sona_id did not reach the payload: ${payload?.participant_data.sona_id}`);
  check(payload?.participant_data.participant_id === "TEST42",
        `the SONA code should be the participant id, got ` +
        `${payload?.participant_data.participant_id}`);
  check(/credit has been granted/.test(sonaStatus),
        `the closing screen did not report the credit: "${sonaStatus.trim()}"`);
}
if (CHS) {
  // The form must not appear, and the ids CHS supplied must reach the payload
  // -- they are the only way to join this session to the family afterwards.
  check(!setupSeen, "the setup form appeared for a family at home");
  check(payload?.participant_data.chs_child === "SG7JLN",
        `chs_child did not reach the payload: ` +
        `${payload?.participant_data.chs_child}`);
  check(payload?.participant_data.chs_response ===
          "d5c8f502-6588-46c8-84fa-a9657a44fe47",
        `chs_response did not reach the payload: ` +
        `${payload?.participant_data.chs_response}`);
  check(payload?.participant_data.participant_id === "SG7JLN",
        `the child hash should seed the session, got ` +
        `${payload?.participant_data.participant_id}`);
  // A CHS session is never offered a download, so `payload` here is the
  // UPLOADED body -- which is the one case this harness can check the
  // submitted shape end to end. save.js's forSubmission keeps the
  // measurement and drops the game layer's own state.
  check(!("game_state" in (payload ?? {})),
        "the game state was uploaded; only responses and participant_data go");
  check(Array.isArray(payload?.responses) && payload.responses.length > 0,
        "a CHS session uploaded no responses");
}

// Stickers only exist once a session is running, which the setup case never
// reaches.
if (!SETUP) {
  check(stickerImgs > 0, "no sticker was drawn from an image; they fell back to emoji text");
}
check(stickerTextOnly === 0,
      `${stickerTextOnly} sticker slots rendered as text rather than an image`);

// The closing screen. Painted by main.js's showAllDone AFTER the timeline
// ends, not as the last item on it -- so what this asserts is precisely the
// thing that used to go wrong: that something is still on screen once jsPsych
// has cleared its display element.
if (!SETUP) {
  check(/All done/i.test(target.textContent),
        `no closing screen after the session: ` +
        `"${target.textContent.trim().slice(0, 80)}"`);
  const corner = target.querySelector(".corner-btn");
  check(CHS || SONA ? !corner : Boolean(corner),
        CHS || SONA ? "a participant at home was offered a data download"
            : "the closing screen has no corner download button");
}

console.log("sticker <img> samples :", stickerImgs, "| text-only slots:", stickerTextOnly);
// The mansion, end to end: every screen reachable, and everything done in
// them recorded in the file the analysis reads.
if (!SETUP && payload?.game_state?.castle) {
  const castleState = payload.game_state.castle;
  check(mansionVisits > 0, "the mansion was never reached");
  check(Array.isArray(castleState.mansion) && castleState.mansion.length === 9,
        `the saved castle has no mansion: ${castleState.mansion?.length}`);
  check(castleState.mansion?.[0]?.unlocked === true,
        "mansion room 0 was not open at the start");
  check(castleState.mansion?.filter((r) => r.kind === "arcade").length === 4,
        "the mansion did not carry four game rooms");
  if (arcadeRounds > 0) {
    check((castleState.minigame_plays ?? []).length > 0,
          "a round was played but no minigame_plays were recorded");
    check(castleState.minigame_ms > 0, "a round was played but minigame_ms is 0");
    // Arcade coins are capped and kept OUT of the response-blind schedule.
    check(castleState.minigame_coins <= 12,
          `arcade coins past the session cap: ${castleState.minigame_coins}`);
    check(castleState.minigame_plays.some((p) => p.score > 0),
          "a played round scored nothing");
    const play = castleState.minigame_plays[0];
    check(play.coins <= 2, `one round paid ${play.coins}, over the per-round ceiling`);
    check(play.duration_ms === 20000, `a round lasted ${play.duration_ms}ms`);
  }
  if (roomsEntered > 0) {
    check((castleState.placements ?? []).length > 0,
          "a room was decorated but nothing was placed");
  }
  if (retrieveAttempted) {
    check(retrieveWorked, "dragging a placed item into the tray did not retrieve it");
  }
  if (shopVisits > 0) {
    check(!shopUndefinedSeen, "a shop item rendered literally as \"undefined\"");
    if (shopAnyAffordable) {
      check(shopPurchases > 0, "an affordable item was shown but nothing was bought");
      const shopState = payload.game_state?.shop;
      check(shopState?.purchases?.length > 0,
            "the shop was visited and bought from, but no purchase was recorded");
      // At least one owned_* array must have grown, or a purchase was
      // recorded with nothing to show for it -- the exact failure mode a
      // base-id/variant-id lookup mismatch produces (recorded, but silently
      // never resolves to real art/label anywhere it's read back).
      check((shopState?.owned_furniture?.length ?? 0) + (shopState?.owned_backgrounds?.length ?? 0)
            + (shopState?.owned_animals?.length ?? 0) > 0,
            "purchases were recorded but nothing ended up owned");
    }
    if (bgPlacements > 0) {
      check(Object.keys(shopState?.background_overrides ?? {}).length > 0,
            "the background room-picker was used but nothing was equipped");
    }
  }
}

console.log("mansion               :", `${mansionVisits} screens, `
  + `${roomsEntered} rooms entered, ${arcadeRounds} rounds, `
  + `${shopVisits} shop visits, ${shopPurchases} purchases, ${bgPlacements} bg placements`);
console.log("retrieve gesture      :",
  retrieveAttempted ? (retrieveWorked ? "worked" : "FAILED") : "not exercised (nothing was ever placed)");
console.log("minigame plays        :", payload?.game_state?.castle?.minigame_plays?.length ?? 0,
  "| arcade coins:", payload?.game_state?.castle?.minigame_coins ?? 0);
console.log("rooms completed       :", payload?.game_state?.castle?.rooms
  .filter((r) => r.completed).length, "/", payload?.game_state?.castle?.rooms.length);
// jsdom ships no 2D canvas backend unless the (heavy, native) `canvas`
// package is installed, and says so on every getContext(). That is a property
// of this harness's environment, not of the build -- the games check for a
// null context and play on unseen, which is what lets a round be driven here
// at all. Dropped so it cannot mask a real error.
const realErrors = errors.filter((e) => !/HTMLCanvasElement.*getContext/.test(e));

console.log("console warnings      :", warnings.length ? warnings : "none");
console.log("errors                :", realErrors.length ? realErrors : "none");
console.log("assertions            :", fail.length ? fail : "all passed");

process.exitCode = (realErrors.length || fail.length) ? 1 : 0;
