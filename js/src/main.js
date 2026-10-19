/** Timeline assembly. Loads the manifests, builds the session, saves it. */

// jsPsych comes from the standalone build loaded by index.html, not an
// import. The CDN's ESM dist has bare imports a browser cannot resolve, and
// jsDelivr's /+esm output still fetches dependencies from the CDN at runtime;
// the standalone build is the only one that works offline.
const { initJsPsych } = globalThis.jsPsychModule ?? {};
import { CONFIG, applyUrlOverrides } from "./config.js";
import { stream } from "./rng.js";
import { buildTrialList, generateBalancedTriplets } from "./triplets.js";
import { blockConditions, latinSquareIndex, buildTrialListTier2,
         CONDITION_INSTRUCTIONS, CONDITION_DIALOGUE } from "./tier2.js";
import { CastleState, ARCADE_ROOMS } from "./castle.js";
import { ShopState } from "./shop.js";
import { TripletPlugin, ScreenPlugin } from "./plugins.js";
import { AudioTripletPlugin, armPriming, stimulusAudioActive } from "./audio.js";
import { initSfx, playSfx } from "./sfx.js";
import { initVoice, speak, speakKeys, stopVoice } from "./voice.js";
import { initMusic, playMusic, stopMusic } from "./music.js";
import { initStickerPopup, showStickerReveal } from "./sticker_popup.js";
import { initItemPopup } from "./item_popup.js";
import { CutscenePlugin, resolvePanels, probeImages } from "./cutscene.js";
import { PlaygroundPlugin } from "./playground.js";
import { MansionPlugin } from "./mansion.js";
import { ShopPlugin } from "./shop_plugin.js";
import { buildPayload, makeResponse, downloadPayload, postPayload } from "./save.js";
import { admitSession, getTicket } from "./captcha.js";
import { sessionPlan } from "./session.js";
import { setupNeeded, showSetup } from "./setup.js";
import { showConsentGate } from "./consent.js";
import { initAssets, assetUrl, assetSavings, prefetch, idlePrefetch } from "./assets.js";

let cfg = applyUrlOverrides({ ...CONFIG });
let TIER2 = cfg.Tier === 2;

// Chrome will not start playback on a page nobody has touched, and a blocked
// A-only trial is a silent one. Every session opens with screens the child
// taps, so clicks always precede the first sound; armPriming retries on each
// until one of them unlocks the tab.
armPriming();

const jget = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`could not load ${url} (${r.status})`);
  return r.json();
};

/**
 * Loading overlay shown between "Start" and the first painted trial. Lives
 * OUTSIDE #jspsych-target (a sibling on <body>), never inside it --
 * initJsPsych() appends its own .jspsych-content-wrapper alongside whatever
 * is already in display_element rather than clearing it, so anything placed
 * directly inside #jspsych-target beforehand is stranded as a permanent
 * sibling no plugin ever touches: not overlapping via z-index, just stacked
 * above the game in normal document flow, pushing it below the fold forever.
 *
 * Returns a function that fades the overlay out and removes it -- call that
 * once the first trial has actually painted underneath (see jsPsych.run()
 * below). The CSS transition is skipped under prefers-reduced-motion, so the
 * fallback timeout is what removes it there instead of `transitionend`.
 */
function showLoadingOverlay() {
  const el = document.createElement("div");
  el.className = "loading-overlay";
  el.innerHTML = `
    <div class="spinner" aria-hidden="true"></div>
    <p class="hint">Getting things ready…</p>`;
  document.body.appendChild(el);
  return () => {
    el.classList.add("hide");
    el.addEventListener("transitionend", () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  };
}

(async function run() {
  const target = document.getElementById("jspsych-target");

  // The experimenter's form, when the link did not already configure the
  // session. A URL carrying ?pid= is one someone has already set up -- a
  // facility link, or the test harness -- so it starts straight away.
  if (setupNeeded()) cfg = await showSetup(cfg, target);

  // MELD consent/assent, gated on age -- for every session, including CHS
  // ones, which carry no age at all until this runs. See consent.js: it asks
  // a minimal age-only question first when cfg.Age is still blank, so this
  // also fills in the age sessionPlan() reads just below, instead of that
  // path silently defaulting to the adult bin.
  cfg = await showConsentGate(cfg, target);

  // Length comes from the age-bin table unless the URL pinned it, so opening
  // the page bare gives the same session the desktop build would. `Num
  // Trials` is trials PER BLOCK; handing it the session total is what made
  // the desktop build run an adult's "80 trial" session as 704.
  // Whether the URL actually pinned it, not whether it mentioned it -- a
  // rejected ?rooms= (unparseable, or a CHS session, where the length is not
  // the visitor's to set) has to fall through to the plan rather than to
  // CONFIG's placeholder. See config.js's session_length_pinned.
  if (!cfg.session_length_pinned) {
    const plan = sessionPlan(cfg.Age || 25, cfg.Session_Duration, cfg.Tier);
    cfg["Num Blocks"] = plan.blocks;
    cfg["Num Trials"] = plan.perBlock;
  }
  TIER2 = cfg.Tier === 2;

  // Bot gate, once, before anything else loads -- a bot that never solves it
  // never even downloads the manifests/stimuli, let alone runs a session.
  // See js/src/captcha.js for why this degrades to ungated when no site key
  // is configured (local dev, the test harness) but fails CLOSED when one
  // IS configured and something breaks.
  try {
    await admitSession({ siteKey: cfg.turnstile_site_key, pid: cfg.participant_id, target });
  } catch (e) {
    target.innerHTML = `<div class="captcha-gate">
      <p>Could not verify this session (${e.message}).</p>
      <p>Please reload the page and try again.</p>
    </div>`;
    return;
  }
  // Manifests, asset warm-up, and voice/sfx/music init below all run before
  // jsPsych.run() paints the first screen -- with nothing shown here, that
  // stretch is a blank page that reads as a freeze right after the child (or
  // the experimenter, on their behalf) hits Start.
  //
  // This lives OUTSIDE #jspsych-target (a sibling on <body>, not a child) and
  // is removed explicitly once jsPsych.run() below has painted the first
  // trial -- see showLoadingOverlay's caller. It cannot be left for jsPsych
  // to clear on its own: initJsPsych() does not clear display_element, it
  // APPENDS its own .jspsych-content-wrapper alongside whatever is already
  // there, so anything placed directly in #jspsych-target beforehand (as this
  // used to be) is stranded as a permanent sibling no plugin ever touches --
  // not overlapping via z-index, just stacked above the game in normal flow,
  // pushing it below the fold forever.
  const hideLoadingOverlay = showLoadingOverlay();

  const datasetRoot = TIER2 ? cfg.tier2_dataset_root : cfg.dataset_root;
  const [manifest, dialogue, stimuli] = await Promise.all([
    jget(`${cfg.asset_root}/manifest.json`),
    jget(`${cfg.asset_root}/dialogue/dialogue_en.json`),
    jget(`${datasetRoot}/manifest.json`),
  ]);

  let entries = Array.isArray(stimuli) ? stimuli : stimuli.concepts;
  if (TIER2) {
    // Only fully matched items. A concept missing either modality cannot be
    // presented in all three conditions, so it cannot enter the within-item
    // AV vs (V + A) contrast at all.
    entries = entries.filter((e) => e.has_audio && e.has_image);
  }
  const concepts = entries.map((e) => e.concept_id);
  const imageFor = Object.fromEntries(
    entries.map((e) => [e.concept_id, `${datasetRoot}/${e.image_file}`]));
  const audioFor = TIER2 ? Object.fromEntries(
    entries.map((e) => [e.concept_id, `${datasetRoot}/${e.audio_file}`])) : {};

  const rooms = cfg["Num Blocks"];
  const perRoom = cfg["Num Trials"];
  const totalRegular = rooms * perRoom;

  // Separate streams, exactly as the PyQt build does: drawing the reward
  // schedule or the room art from the trial stream would shift which triplets
  // the participant sees.
  const pid = cfg.participant_id;

  // One room = one block. In Tier 2 a block is also a CONDITION, assigned by
  // Latin square so modality is not confounded with time-on-task.
  const conditions = TIER2
    ? blockConditions(rooms, latinSquareIndex(stream(pid, "tier2_latin")))
    : Array.from({ length: rooms }, () => "V");

  let trials;
  if (TIER2) {
    const mode = cfg.Tier2_Triplet_Mode || "shared";
    // "shared" needs one block's worth per PASS over the three conditions:
    // the same list is re-presented within a pass, which is what yokes the
    // contrast to the item, and the next pass needs its own triplets so a
    // triplet is judged once per condition rather than once per block.
    const passes = Math.max(1, Math.ceil(rooms / 3));
    const nTriplets = mode === "shared" ? perRoom * passes : totalRegular;
    trials = buildTrialListTier2({
      concepts,
      conditions,
      perBlock: perRoom,
      regularTriplets: generateBalancedTriplets(
        concepts, nTriplets, stream(pid, "tier2_triplets")),
      mode,
      orderRng: stream(pid, "tier2_order"),
    });
  } else {
    trials = buildTrialList(concepts, totalRegular,
                            stream(pid, "tier1_triplets"),
                            stream(pid, "tier1_order"),
                            rooms, perRoom);
  }
  const feedbackRng = stream(pid, "feedback");

  // The game's own sound effects, named in the manifest. Gated on stimulus
  // playback so a chime can never land over a Tier 2 clip.
  initSfx({
    assetRoot: cfg.asset_root,
    sounds: cfg.Gamify ? (manifest.sounds ?? {}) : {},
    muted: cfg.Gamify_Mute_SFX,
    isStimulusActive: stimulusAudioActive,
  });

  // Narrated dialogue -- see js/src/voice.js. Fetches voice_manifest.json to
  // learn which lines have a recording; every speak() call below is a no-op
  // for the rest, so nothing here needs a Gamify guard the way sfx does.
  await initVoice({ assetRoot: cfg.asset_root });

  // Cutscene background music, gated the same way -- see js/src/music.js.
  // Fade duration obeys the same reduced-motion cap the cutscene's own
  // visual cross-fade does below (`fadeMs`), computed here since initMusic
  // runs first.
  const musicFadeMs = cfg.Gamify_Reduced_Motion
    ? Math.min(Number(manifest.music?.fade_ms ?? 1200),
               Number(manifest.accessibility?.reduced_motion?.max_animation_ms ?? 200))
    : Number(manifest.music?.fade_ms ?? 1200);
  initMusic({
    assetRoot: cfg.asset_root,
    music: cfg.Gamify ? (manifest.music ?? {}) : {},
    muted: cfg.Gamify_Mute_SFX,
    fadeMs: musicFadeMs,
  });

  // Mid-trial sticker-reveal popup -- see js/src/sticker_popup.js.
  initStickerPopup({ reducedMotion: Boolean(cfg.Gamify_Reduced_Motion) });
  // Shop-purchase popup -- see js/src/item_popup.js.
  initItemPopup({ reducedMotion: Boolean(cfg.Gamify_Reduced_Motion) });

  if (TIER2) {
    // Warm the cache for exactly the clips this session uses, so the first
    // play of a trial is not a download. Only the ones actually scheduled --
    // the full bank is ~17 MB and most of it is never heard.
    const needed = [...new Set(trials.flatMap((t) => t.concepts))];
    for (const c of needed) {
      const a = new Audio(audioFor[c]);
      a.preload = "auto";
      a.load();
    }
  }

  // Same idea for TripletPlugin/AudioTripletPlugin's stimulus images -- both
  // tiers show them (Tier 2 AV as well as V), so this isn't gated on TIER2.
  // Unlike the Tier 2 audio above, these come from datasetRoot, not
  // assets/game/, so they are outside assets.js's WebP pipeline; setting
  // `.src` on a detached Image starts the fetch immediately and the browser
  // cache serves the real <img> in TripletPlugin later, same fire-and-forget
  // shape as the Audio().load() above.
  for (const c of new Set(trials.flatMap((t) => t.concepts))) {
    new Image().src = imageFor[c];
  }

  // Web-sized art where it has been built, the original PNG where it has
  // not -- see js/src/assets.js. Read once here so every URL below goes
  // through it; nothing waits on it, because assetUrl() falls back until it
  // resolves.
  await initAssets(cfg.asset_root);
  const webAssets = assetSavings();
  if (webAssets) {
    console.log(`[assets] ${webAssets.count} images, `
      + `${(webAssets.web / 1e6).toFixed(1)}MB web-sized `
      + `(${(webAssets.src / 1e6).toFixed(1)}MB as PNG)`);
  }

  const mascot = cfg.Gamify
    ? assetUrl(manifest.mascot_variants.neutral.idle) : "";
  const mascotHappy = cfg.Gamify
    ? assetUrl(manifest.mascot_variants.neutral.happy) : "";

  // Each room's OWN trial count, in room order -- what the sticker reveal
  // schedule needs to pick a valid trial-within-room to reveal each of that
  // room's stickers at. Room length is not always uniform (Tier 2 blocks can
  // differ slightly), so this is a real count per room, computed the same
  // way roomOf() below does (defined later; inlined here since this runs
  // first).
  const roomTrialCounts = Array(rooms).fill(0);
  for (const t of trials) {
    const r = TIER2 ? t.block : t.room;
    if (r >= 0 && r < rooms) roomTrialCounts[r] += 1;
  }

  // `conditions` is recorded per room, so the Latin square a session actually
  // ran is reconstructable from the saved file rather than re-derived from
  // the id (which would need this build's hash to be known).
  const castle = cfg.Gamify
    ? CastleState.create(rooms, manifest.stickers.pool,
                         stream(pid, "castle"), pid, conditions, trials.length,
                         roomTrialCounts)
    : null;

  if (castle) {
    const files = manifest.rooms.progression || [];
    const repeatFrom = manifest.rooms.repeat_from || 1;
    const bg = stream(pid, "backdrop");
    for (const r of castle.rooms) {
      r.backdrop = r.index < files.length
        ? files[r.index]
        : bg.choice(files.slice(repeatFrom - 1));
    }
  }

  // Shop / economy. A fourth isolated rng stream, sibling of "castle" and
  // "backdrop" above: every mystery-box draw comes from THIS stream and
  // nothing else, so a purchase can never be traced back to, or influence,
  // a trial -- see shop.js's module docstring.
  const shop = cfg.Gamify ? new ShopState() : null;
  const shopRng = stream(pid, "shop");

  // The mini-games' own rng stream, sibling of "castle"/"backdrop"/"shop": a
  // spawn position drawn from the trial stream would shift which triplets the
  // child sees, which is the property test_trial_determinism.py protects.
  const gameRng = stream(pid, "minigames");

  // Where the guests move to at each block boundary. Its own stream for the
  // same reason as every one above it -- and separate from "shop" in
  // particular, so where a pet wanders does not depend on how much the child
  // happened to buy.
  const guestRng = stream(pid, "guests");

  /** The art behind one MANSION room. Reuses the room progression the task
   * rooms draw from, so the mansion looks like the same castle -- and gives
   * the two game rooms with dedicated art (star catcher, bubble pop) their own
   * backdrops where the manifest has them. */
  const roomArt = manifest.rooms?.progression ?? [];
  const arcadeArt = {
    star_catcher: "room/arcade/star_catcher.png",
    bubble_pop: "room/arcade/bubble_pop.png",
  };
  const progressionArt = (index) =>
    roomArt[index % Math.max(1, roomArt.length)] || "";
  const mansionBackdrop = (index) => {
    // A shop-bought background, equipped into this room, overrides whatever
    // the room would otherwise show -- checked first, same precedence
    // _room_backdrop_rel gives it on the desktop build.
    const overrideId = shop?.background_overrides?.[index];
    if (overrideId) {
      const rel = backgroundItem(overrideId).rel;
      if (rel) return rel;
    }
    const game = ARCADE_ROOMS[index];
    // Only star_catcher and bubble_pop have art drawn FOR them. The other two
    // used to borrow star_catcher's, which put the same night sky behind
    // three of the four game rooms -- the arcade read as one room the child
    // kept walking back into. Falling through to this room's own entry in
    // the progression instead gives every game room a different backdrop,
    // and costs nothing: `progression` already has one distinct image per
    // mansion index, and the entries at the two borrowing rooms (3 and 6)
    // are exactly the ones a decoration room there would have used.
    if (game) return arcadeArt[game] || progressionArt(index);
    return progressionArt(index);
  };

  // Which animals turn up to watch a round. Decorative only: they sit below
  // the play area and cannot be caught or clicked. Port of the desktop's
  // _arcade_spectators -- the child's OWN invited animals first (an animal
  // that lives in the mansion coming to watch is a nicer thing than a
  // stranger), THEN the rest of the pool, shuffled, to fill the bench --
  // the desktop always pads up to MAX_SPECTATORS this way, even before any
  // animal has been invited, by design (own comment: "fill the bench").
  // Computed LIVE, at the moment a round actually starts (see showArcade's
  // trial.spectators() call), not once at timeline-build time as the
  // previous version did -- that meant a mid-session invitation could never
  // move an animal to the front of the bench, and the same fixed first-4-
  // in-manifest-order animals showed up regardless of who was actually
  // owned. Drawn from the shop's own rng stream, never the trial rng, same
  // rule every other shop-adjacent draw in this file follows.
  const MAX_SPECTATORS = 4;
  const arcadeSpectators = () => {
    if (!shop) return [];
    const mine = [...shop.owned_animals];
    const others = (manifest.animals?.pool ?? []).map((a) => a.id)
      .filter((id) => id && !mine.includes(id));
    shopRng.shuffle(others);
    return [...mine, ...others].slice(0, MAX_SPECTATORS)
      .map((id) => animalsById[id]?.image).filter(Boolean);
  };

  //: Each game names its own scoring sound, so the rooms sound different
  //: without the screen knowing which game it built.
  const gameSound = (key) => ({
    star_catcher: "sticker", bubble_pop: "pickup",
    firefly_catch: "select", kite_flyer: "sticker",
  }[key] || "select");

  // Which cutscene panels actually exist. game_layer.cutscene_panels checks
  // the filesystem; a browser can only ask by loading, so ask once up front
  // and let the timeline builder decide art-vs-text from the answer. Loading
  // now also means the opening does not stutter on its first fade.
  const artUrls = ["open", "close"].flatMap((w) =>
    (manifest.cutscene?.[w] ?? []).map((p) => p?.image && assetUrl(p.image)));
  const usableArt = cfg.Gamify ? await probeImages(artUrls) : new Set();

  // Reduced-stimulation mode obeys the same cap the selection animation does:
  // unexpected movement is the thing the mode exists to limit.
  const fadeMs = cfg.Gamify_Reduced_Motion
    ? Math.min(Number(manifest.cutscene?.fade_ms ?? 450),
               Number(manifest.accessibility?.reduced_motion?.max_animation_ms ?? 200))
    : Number(manifest.cutscene?.fade_ms ?? 450);

  const stickerById = Object.fromEntries(
    manifest.stickers.pool.map((s) => [s.id, s]));

  /** A sticker plus the URL of its picture, which is what gets drawn.
   *
   * Stickers used to render as emoji text, leaving the glyph to whatever
   * emoji font the machine had -- a tofu box on a Linux box with none
   * installed, and missing the Unicode 14/15 entries in the pool even where
   * one is. The manifest's `image` is written by
   * utilities/build_emoji_assets.py; the emoji stays as the fallback.
   */
  const sticker = (id) => {
    const s = stickerById[id] || {};
    // `rel` is the manifest path, kept alongside the resolved URL so the
    // prefetcher can ask assets.js for a different size of the same art.
    return { id, emoji: s.emoji, rel: s.image || null,
             img: s.image ? assetUrl(s.image) : null };
  };
  const stickerHtml = (s) => (s && s.img
    ? `<img class="sticker-art" src="${s.img}" alt="${s.emoji || ""}">`
    : (s && s.emoji) || "");

  // Furniture and backgrounds (shop addition) -- same id/emoji/img shape as
  // sticker(), so stickerHtml/PlaygroundPlugin never have to know the
  // difference between the three.
  const furnitureById = Object.fromEntries(
    (manifest.furniture?.pool ?? []).map((f) => [f.id, f]));
  // A direct catalog purchase's `ref` is a BASE id ("tapestry"), not a
  // variant id ("tapestry_c") -- the variant is only drawn once bought (see
  // ShopState.buyFurniture, no rng, unlike the desktop). Bases carry a
  // generic label/emoji and no image; furnitureItem() below tries the
  // variant pool first (real art, for an owned/won item) and falls back to
  // the base pool (label/emoji only) for a not-yet-bought catalog entry.
  const furnitureBaseById = Object.fromEntries(
    (manifest.furniture?.bases ?? []).map((f) => [f.id, f]));
  const backgroundsById = Object.fromEntries(
    (manifest.backgrounds?.pool ?? []).map((b) => [b.id, b]));
  const animalsById = Object.fromEntries(
    (manifest.animals?.pool ?? []).map((a) => [a.id, a]));
  const itemOf = (byId) => (id) => {
    const s = byId[id] || {};
    return { id, label: s.label, emoji: s.emoji, rel: s.image || null,
             img: s.image ? assetUrl(s.image) : null };
  };
  const furnitureItem = (id) =>
    (furnitureById[id] ? itemOf(furnitureById) : itemOf(furnitureBaseById))(id);
  // A base's own palette -- what a furniture purchase draws from (see
  // ShopState.buyFurniture) and what the shop cell's "N/total found" reads
  // against. Grouped by the variant's own `base` field, resolved once like
  // furnitureItem() itself.
  const furnitureVariants = (baseId) =>
    (manifest.furniture?.pool ?? []).filter((f) => f.base === baseId).map((f) => furnitureItem(f.id));
  const backgroundItem = itemOf(backgroundsById);
  const animalItem = itemOf(animalsById);

  // Shop catalog, resolved once: each entry carries its own art/label so
  // ShopPlugin never has to look anything up in the manifest itself.
  const shopCatalog = (manifest.shop?.catalog ?? []).map((entry) => {
    if (entry.type === "mystery_box") {
      return { ...entry, pool: (entry.pool ?? []).map((p) => ({
        ...p,
        item: p.type === "furniture" ? furnitureItem(p.ref)
            : p.type === "animal" ? animalItem(p.ref)
            : backgroundItem(p.ref),
      })) };
    }
    if (entry.type === "invitation") {
      // Carries its own label/emoji directly -- an invitation letter has no
      // `ref` into any pool, since who it invites isn't decided (or shown)
      // until it's bought. Mirrors the desktop's _shop_cell "invitation"
      // branch, which reads entry.get("label")/entry.get("emoji") the
      // same way instead of resolving an item pool.
      return { ...entry, item: { id: entry.id, label: entry.label, emoji: entry.emoji, img: null } };
    }
    return { ...entry,
             item: entry.type === "furniture" ? furnitureItem(entry.ref) : backgroundItem(entry.ref) };
  });
  const currencyIcon = manifest.shop?.currency?.icon ?? "\u{1FA99}";

  // Coins earned so far (response-blind, see castle.js) minus everything
  // spent (player-choice-gated, see shop.js) -- just arithmetic over the
  // two, computed here so neither state object needs a reference to the
  // other. Mirrors _coin_balance() in the desktop build.
  // minigame_coins is added HERE rather than folded into coins_awarded: that
  // field means "what the pre-drawn, response-blind schedule paid" and stays
  // reproducible from the participant id alone. Arcade coins depend on how the
  // child played, so they are counted separately and only meet at the balance.
  // Debug_Bonus_Coins (?bonus_coins=N) is added here, on the SPENDABLE
  // balance only -- never folded into castle.coins_awarded/minigame_coins,
  // which stay exactly the response-blind, reproducible-from-the-pid
  // record every audit of this file relies on. A dev/QA convenience for
  // reaching the shop/mansion with money, not something a real
  // participant session would ever carry (0 unless the URL asks for it).
  const coinBalance = () => (castle && shop
    ? castle.coins_awarded + castle.minigame_coins - shop.totalSpent + (cfg.Debug_Bonus_Coins || 0)
    : 0);

  const startTime = new Date().toISOString().slice(0, 19).replace("T", " ");
  const responses = [];

  // #jspsych-target still holds whatever showSetup/showConsentGate last wrote
  // into it -- neither clears itself on the way out, and nothing since has
  // touched target (the loading overlay above lives on <body>, not in here).
  // initJsPsych() does not clear display_element either: it APPENDS its own
  // .jspsych-content-wrapper as a sibling of whatever is already there, so
  // without this the consent screen would be stranded as a permanent sibling
  // of the wrapper -- same shape as the loading-overlay bug this file used to
  // have, just via a different leftover screen.
  target.innerHTML = "";

  const jsPsych = initJsPsych({
    display_element: "jspsych-target",
    // The closing screen is painted HERE rather than being the last item on
    // the timeline, because it is the one screen with nothing after it. A
    // ScreenPlugin screen has to be dismissed to advance, and dismissing the
    // last one left the child looking at an empty page -- jsPsych clears the
    // display element when the timeline ends.
    //
    // save() is deliberately not awaited: it captures the payload and writes
    // the file synchronously, and only the upload is async. Waiting on a POST
    // that can take seconds would put a blank page exactly where the blank
    // page used to be.
    on_finish: () => {
      const saving = save(true);
      showAllDone();
      if (cfg.sona_id) reportSonaOutcome(saving);
    },
  });

  /**
   * Tell a SONA participant what became of their data and their credit.
   *
   * The server grants credit only after it has stored the final upload (see
   * api/_lib/sona.js), so there is nothing to redirect to: the answer to
   * "did I get credit" arrives in the upload's own response. An upload that
   * still fails after uploadFinal's retries offers another try rather than a
   * dead end -- this tab holds the only copy of the session.
   */
  function reportSonaOutcome(saving) {
    const status = (html) => {
      const el = target.querySelector("#sona-status");
      if (el) el.innerHTML = html;
      return el;
    };
    saving.then((result) => {
      if (!result?.ok) {
        const el = status(
          "We could not save your responses. Please keep this tab open, check "
          + "your internet connection, and press Try again.<br>"
          + `<button class="big" id="sona-retry" type="button">Try again</button>`);
        el?.querySelector("#sona-retry").addEventListener("click", () => {
          status("Saving your responses&hellip; please keep this tab open.");
          reportSonaOutcome(uploadFinal(finalPayload).catch(() => null));
        });
      } else if (result.credit === "granted") {
        status("Your responses are saved and your SONA credit has been granted. "
          + "You can close this tab now. Thank you!");
      } else {
        status("Your responses are saved. Your SONA credit could not be granted "
          + "automatically, so the research team will grant it for you &mdash; "
          + `you do not need to do anything else. Your code is <b>${cfg.sona_id}</b>.`);
      }
    });
  }

  // The last payload built, so the closing screen's download button has
  // something to hand back without rebuilding it from state that has since
  // been torn down.
  let finalPayload = null;

  let saved = false;
  async function save(completed) {
    if (saved) return null;
    saved = true;
    const payload = buildPayload({ config: cfg, responses, castle, shop, startTime, completed });
    finalPayload = payload;
    // NOTHING is downloaded automatically. A save dialog appearing unbidden on
    // a family's own computer at the end of a children's study is startling in
    // a way the data does not require: the experimenter's copy is a button on
    // the closing screen (see showAllDone), taken deliberately when it is
    // wanted. `offer_download` still decides whether that button exists at
    // all, so a CHS session -- where a file on a parent's machine is not a
    // data pipeline -- still offers nothing.
    //
    // The consequence for error handling: upload_url is now the only route out
    // that happens on its own, in EVERY arm rather than only under CHS. A
    // failure there is loud for that reason, and no longer has a file already
    // on disk to fall back on -- only a button someone has to notice.
    if (cfg.upload_url) {
      try { return await uploadFinal(payload); }
      catch (e) {
        console.error(cfg.offer_download === false
          ? "upload failed and no download was offered -- this session is lost"
          : "upload failed; the closing screen's download button is the only "
            + "remaining copy -- take it before leaving this page", e);
      }
    } else if (cfg.offer_download === false) {
      console.error("CHS session with no upload_url: nowhere to put the data");
    } else {
      // No endpoint and nothing automatic: this session exists only in this
      // tab, behind the closing screen's button. Worth saying out loud, because
      // it used to be the case that a run configured this way still produced a
      // file without anyone doing anything, and closing the tab is now enough
      // to lose it.
      console.warn("no upload_url: this session is only in the closing "
        + "screen's download button -- closing the tab discards it");
    }
    return null;
  }

  // The server's answer to the final upload: {ok, id, credit}. A SONA
  // participant's credit hangs on this one POST and they have no download
  // button to fall back on, so it gets retried with backoff (2s, 4s, 8s);
  // everywhere else a failure is left to the closing screen's button.
  async function uploadFinal(payload) {
    const tries = cfg.sona_id ? 4 : 1;
    for (let i = 1; ; i++) {
      try {
        const res = await postPayload(cfg.upload_url, payload, { ticket: getTicket() });
        return { ok: true, ...(await res.json().catch(() => ({}))) };
      } catch (e) {
        if (i >= tries) throw e;
        await new Promise((r) => setTimeout(r, 2000 * 2 ** (i - 1)));
      }
    }
  }

  /**
   * The last thing the child sees, and the end of the session.
   *
   * Terminal on purpose: no button that advances, because there is nowhere to
   * advance to. This used to be the final screen ON the timeline, with a
   * "Finished!" button -- which a child duly pressed, and jsPsych cleared the
   * display element, and they were left looking at a blank page.
   *
   * The closing line is `finish[0]`, not a random draw from the pair. Every
   * other screen picks for variety because a child sees it many times in a
   * session; this one they see once, and pinning it means the text and the
   * recording named by the same index can never disagree.
   *
   * The experimenter's copy of the data sits in the corner, in the place and
   * shape of the pause control the session has used throughout, rather than
   * as a big button in a child's line of sight -- it is not addressed to them.
   * Since nothing downloads on its own any more (see save), this button is the
   * ONLY way to a local file, not a second chance at one: on a run with no
   * upload_url it is the only copy of the session that will ever exist. Absent
   * under CHS, where a save prompt on a parent's computer is not a data
   * pipeline.
   */
  function showAllDone() {
    const FALLBACK = "All done! Thank you so much for playing with me.";
    const text = dialogue.finish?.[0] ?? FALLBACK;
    if (cfg.Gamify) {
      playSfx("finish");
      speak("finish", 0);
    }
    target.innerHTML = `
      <div class="screen">
        ${cfg.Gamify && mascot ? `<img class="pip big-pip" src="${mascot}" alt="">` : ""}
        <p class="speech">${text}</p>
        ${cfg.sona_id ? `<p class="hint" id="sona-status">Saving your responses&hellip;
          please keep this tab open.</p>` : ""}
      </div>`;

    if (cfg.offer_download === false || !finalPayload) return;
    const btn = document.createElement("button");
    btn.className = "corner-btn";
    // Now that nothing downloads on its own, this button is the only path to a
    // file -- so the jsdom harness has to press it to see a payload at all.
    // The id is that handle: matching on the label would tie the only
    // end-to-end test of this path to the wording of a button.
    btn.id = "download-data";
    btn.type = "button";
    btn.textContent = "Download data";
    btn.addEventListener("click", () => downloadPayload(finalPayload));
    target.appendChild(btn);
  }

  // Fired at every room boundary (see the on_finish hook near atRoomEnd,
  // above), in addition to save()'s end-of-session call -- the desktop
  // build uploads per TRIAL with a local retry queue (utilities/
  // redcap_utils.py); a browser tab has no local queue to retry against, so
  // this is the closest equivalent: a child who disengages, or whose tab
  // crashes, partway through still has every room up to that point
  // recorded at upload_url, not just whatever save()'s single end-of-
  // session POST would have captured if it never got the chance to fire.
  // Does NOT set the `saved` latch or trigger a download: this is purely a
  // server-side checkpoint, and save() still owns "the session is over".
  // `responses` at call time already includes every trial through the room
  // that just ended, so this payload is self-contained, not a delta.
  async function saveBlock(roomIndex) {
    if (!cfg.upload_url) return;
    const payload = buildPayload({ config: cfg, responses, castle, shop, startTime, completed: false });
    try { await postPayload(cfg.upload_url, payload, { ticket: getTicket(), block: roomIndex }); }
    catch (e) { console.error(`per-block upload failed (room ${roomIndex})`, e); }
  }

  // A child who stops partway still yields data: "trials completed before
  // disengagement" is one of the measures the pilot is built around.
  window.addEventListener("beforeunload", () => { if (responses.length) save(false); });

  const line = (key, fallback = "") => {
    const arr = dialogue[key];
    return arr && arr.length ? arr[Math.floor(feedbackRng.random() * arr.length)] : fallback;
  };

  // Like line(), but also returns the index picked -- needed wherever the
  // matching recording has to be spoken via speak(key, index). Kept separate
  // from line() rather than changing its return shape: several of line()'s
  // callers (e.g. trial_prompt, playground_prompt below) run at timeline-
  // build time, long before that screen is actually shown, so speaking
  // there would fire the recording at the wrong moment -- exactly the
  // overlap hazard GameLayer.line()'s speak=False guards against on the
  // desktop build. Callers that DO want audio call speak()/pick() together
  // from inside an on_start hook or a dynamic html() function, which jsPsych
  // evaluates when the screen is actually reached.
  // `rng` defaults to feedbackRng (every existing caller); pauseRng passes
  // its own stream below, so paused/nudge text draws never shift the
  // after_response sequence every session/test already depends on.
  const pick = (key, rng = feedbackRng) => {
    const arr = dialogue[key];
    if (!arr || !arr.length) return [null, null];
    const idx = Math.floor(rng.random() * arr.length);
    return [arr[idx], idx];
  };

  const timeline = [];

  /**
   * A story scene: cross-fading panels when the art is there, and the
   * text-only screens otherwise. Art is made after the code, so a
   * half-populated cutscene/ folder must degrade rather than show a child
   * blank frames.
   */
  function pushCutscene(which, lastButton) {
    const panels = resolvePanels(manifest, dialogue, which, cfg.asset_root, usableArt);
    if (panels.length) {
      timeline.push({
        type: CutscenePlugin,
        panels,
        fade_ms: fadeMs,
        box_rel: Number(manifest.cutscene?.dialogue_box_rel_height ?? 0.18),
        // One recording per panel, spoken as the panel comes up. The scene
        // is a single trial, so on_start could only ever narrate the first
        // line -- and speak() cuts whatever was still talking, so a fast
        // tapper gets the voice following the picture.
        voice: { onPanel: (n) => speak(`cutscene_${which}`, panels[n].line) },
        // jsPsych core hooks, not plugin params -- music brackets the scene
        // whether it is skipped by a fast tapper or watched in full.
        on_start: () => playMusic(which),
        on_finish: () => stopMusic(),
      });
      return;
    }
    const cutsceneKey = `cutscene_${which}`;
    const lines = dialogue[cutsceneKey] || [];
    for (const [i, text] of lines.entries()) {
      const first = i === 0;
      const last = i === lines.length - 1;
      timeline.push({
        type: ScreenPlugin,
        html: `<img class="pip big-pip" src="${mascot}" alt=""><p class="speech">${text}</p>`,
        button: last ? lastButton : "Next",
        // Each panel is its own timeline node here (unlike the desktop's
        // stacked text-only fallback), so speaking on_start is naturally
        // one line at a time -- no queueing needed.
        on_start: () => { if (first) playMusic(which); speak(cutsceneKey, i); },
        on_finish: last ? () => stopMusic() : undefined,
      });
    }
  }

  if (cfg.Gamify) {
    pushCutscene("open", "Let's play!");
    const instructionsKey = TIER2 ? "instructions_tier2" : "instructions_tier1";
    // Picked here (build time) so the same text speakKeys plays below
    // matches what's on screen -- mirrors the desktop's
    // _show_kid_instruction_screen, which combines welcome + instructions
    // into one spoken sequence for the same reason (both would otherwise
    // start playing at the same instant).
    const [welcomeText, welcomeIdx] = pick("welcome");
    const instrLines = dialogue[instructionsKey] || [];
    timeline.push({
      type: ScreenPlugin,
      html: `<img class="pip big-pip" src="${mascot}" alt="">` +
            (welcomeText ? `<p class="speech">${welcomeText}</p>` : "") +
            instrLines.map((t) => `<p class="speech">${t}</p>`).join(""),
      button: "▶️ Start",
      // Every instruction line shows at once here (unlike the cutscene
      // panels above), so this queues them instead of firing together.
      on_start: () => speakKeys(
        [["welcome", welcomeIdx]].concat(instrLines.map((_, i) => [instructionsKey, i]))),
    });
  }

  // ONE prompt per condition, drawn once. The desktop build uses stable_line
  // for the same reason: a prompt that reworded itself between trials reads
  // to a child as the instruction having changed.
  const promptFor = {};
  for (const cond of new Set(conditions)) {
    promptFor[cond] = cfg.Gamify
      ? line(CONDITION_DIALOGUE[cond].prompt,
             "Which one is the most different from the other two?")
      : CONDITION_INSTRUCTIONS[cond][1];
  }

  // Pause/nudge wording, drawn ONCE for the whole session (js/src/pause.js
  // bakes them into every trial's static params, unlike the desktop's
  // line(), which re-picks live only when the pause/rest screen actually
  // renders) -- its own stream, not feedbackRng, so adding this feature
  // does not shift the after_response draws every existing session/test
  // already depends on for reproducibility.
  const pauseRng = cfg.Gamify ? stream(pid, "pause") : null;
  const pickOnce = (key) => pick(key, pauseRng)[0] ?? "";
  const pausedText = pauseRng ? pickOnce("paused") : "";
  const nudgeText = pauseRng ? pickOnce("nudge") : "";

  // Both tiers now carry their room on the trial, so a room is a contiguous
  // stretch of the list. Position WITHIN that stretch drives the progress bar,
  // counting attention checks like any other trial: they are trials the child
  // does, and skipping them left the bar frozen for a trial and then full
  // while a trial was still to come.
  const roomOf = (t) => (TIER2 ? t.block : t.room);
  const roomSize = {};
  const posInRoom = trials.map((t) => {
    const r = roomOf(t);
    roomSize[r] = (roomSize[r] ?? 0) + 1;
    return roomSize[r] - 1;
  });

  trials.forEach((t, idx) => {
    const roomIndex = roomOf(t);
    const condition = TIER2 ? t.condition : "V";

    // Tier 2: announce the modality before the first trial of each block.
    if (TIER2 && (idx === 0 || trials[idx - 1].block !== t.block)) {
      const introKey = CONDITION_DIALOGUE[condition].intro;
      // Picked here (build time) so the same text speak() plays below
      // matches what's on screen, but the actual speak() call happens in
      // on_start -- the timeline for every room is built upfront, long
      // before most of it is shown.
      const [introText, introIdx] = cfg.Gamify ? pick(introKey) : [null, null];
      timeline.push({
        type: ScreenPlugin,
        html: cfg.Gamify
          ? `<img class="pip big-pip" src="${mascot}" alt="">` +
            `<p class="speech">${introText ?? "Here's the next room!"}</p>`
          : `<p class="speech">${CONDITION_INSTRUCTIONS[condition][0]}</p>` +
            `<p class="hint">${CONDITION_INSTRUCTIONS[condition][1]}</p>`,
        button: cfg.Gamify ? "Let's go!" : "Continue",
        on_start: cfg.Gamify ? () => speak(introKey, introIdx) : undefined,
      });
    }

    const progress = cfg.Gamify
      ? { current: posInRoom[idx], total: roomSize[roomIndex],
          level: roomIndex + 1, n_levels: rooms }
      : null;

    // Room boundary: also where a per-block save fires (below), so it needs
    // to be known before on_finish is built, not after -- moved up from
    // where it used to sit, right before the gamified reward screen.
    //
    // Keyed off the END OF THE ROOM, never off a count of regular trials.
    // Attention checks are shuffled in among them, so a room's last trial is
    // often an attention one; rewarding at the regular-trial count dropped the
    // reward screen mid-room, and could put the playground BEFORE a trial that
    // still belonged to the room the child had just been congratulated for.
    const isLastTrial = idx === trials.length - 1;
    const atRoomEnd = isLastTrial || roomOf(trials[idx + 1]) !== roomOf(t);

    const common = {
      // A line still speaking from the screen before (the instructions stack
      // queues several) must not run over an A/AV stimulus clip. Same guard
      // as the desktop build's _show_trial.
      on_start: () => stopVoice(),
      concepts: t.concepts,
      is_attention: t.is_attention,
      // Index into the TRIAL list, matching the desktop build. Not jsPsych's
      // own `trial_index`, which counts every timeline node including story
      // screens -- see the note in plugins.js.
      task_trial_index: idx,
      prompt: promptFor[condition],
      gamified: cfg.Gamify,
      mascot, mascot_happy: mascotHappy,
      dialogue, rng: feedbackRng,
      paused_text: pausedText,
      nudge_text: nudgeText,
      progress,
      // Live balance for the header (read at render time, before this
      // trial's own coins land) and a per-trial closure that pays THIS
      // trial's coins and hands back the new total -- see
      // CastleState.awardTrialCoins. Every trial pays, attention checks
      // included, same as the desktop build.
      coin_balance: cfg.Gamify && castle ? coinBalance : null,
      award_coins: cfg.Gamify && castle
        ? () => { castle.awardTrialCoins(idx); return coinBalance(); }
        : null,
      currency_icon: currencyIcon,
      // Stickers: which trial WITHIN its room reveals which sticker was
      // also pre-drawn at session start (see CastleState.awardTrialStickers
      // / allocateRevealPositions), never contingent on WHAT was picked.
      // Unlike coins this is rare -- a room only has 2-4 stickers total --
      // so most trials call this and get nothing back. The popup and its
      // sfx live entirely in this closure so plugins.js/audio.js never need
      // to know about sticker art or CastleState -- they just call it.
      award_stickers: cfg.Gamify && castle
        ? () => {
            const ids = castle.awardTrialStickers(roomIndex, posInRoom[idx]);
            if (ids.length) {
              const s = sticker(ids[0]);
              showStickerReveal({ artUrl: s.img, emoji: s.emoji, onReveal: () => playSfx("sticker") });
            }
            return ids;
          }
        : null,
      on_finish: (d) => {
        const row = makeResponse({
          trialIndex: d.task_trial_index, concepts: d.concepts,
          selected: d.selected_concept, position: d.selected_position,
          isAttention: d.is_attention, rtMs: d.rt, tier: cfg.Tier,
          condition, blockNumber: roomIndex,
        });
        if (condition !== "V") {
          // Additive, A/AV only, ignored by the Python analysis. Kept because
          // response_time_ms on these trials is dominated by ~10s of forced
          // playback -- decision time is response_time_ms - playback_ms --
          // and because a row whose sounds never played is not usable data.
          row.playback_ms = d.playback_ms === null ? null : Math.round(d.playback_ms);
          row.stimulus_autoplay_blocked = Boolean(d.autoplay_blocked);
        }
        responses.push(row);
        // Fires for BOTH arms (gamified or plain), unlike the reward screen
        // below which is Gamify-only -- a baseline-arm session has no room-
        // complete screen to hang this off of otherwise, and losing only
        // the plain arm's per-block saves would be an easy regression to miss.
        // Skipped on the SESSION's last trial: jsPsych's own on_finish fires
        // save(true) moments later with no ordering guarantee between the
        // two unawaited POSTs, so a last-write-wins upload_url endpoint
        // could end up showing a completed session as still in progress.
        if (atRoomEnd && !isLastTrial) saveBlock(roomIndex);
      },
    };

    timeline.push(condition === "V"
      ? { type: TripletPlugin, images: t.concepts.map((c) => imageFor[c]), ...common }
      : { type: AudioTripletPlugin,
          condition,
          audio: t.concepts.map((c) => audioFor[c]),
          images: condition === "AV" ? t.concepts.map((c) => imageFor[c]) : [],
          lead_in_ms: cfg.Audio_Lead_In_Ms,
          per_sound_ms: cfg.Audio_Gap_Ms,
          ...common });

    // Room boundary: award, then let the child arrange.
    if (cfg.Gamify && atRoomEnd && castle && !castle.rooms[roomIndex].completed) {
      const thisRoom = roomIndex;
      const blocksDone = thisRoom + 1;
      // Read by the rest screen and the mansion below, instead of jsPsych's
      // own .last(1) data lookup -- inserting the rest screen BETWEEN the
      // break screen and the mansion would make "the last trial" ambiguous
      // (the break screen if rest was skipped, the rest screen if it
      // wasn't), where this closure variable always means the same thing.
      let breakChoice = { quiet: false, rest: false };
      timeline.push({
        type: ScreenPlugin,
        // The sticker screen is already part of the game layer's "place",
        // not of the trials -- the same track the mansion it leads into
        // runs, started here so it carries across the boundary rather than
        // beginning again when the grid opens.
        on_start: () => playMusic("playground", { loop: true }),
        html: () => {
          const got = castle.completeRoom(thisRoom).map(sticker);
          // Room finished, then the stickers land. Two sounds because they
          // are two events, and the desktop plays both.
          playSfx("level_up");
          setTimeout(() => playSfx("sticker"), 450);
          const [levelCompleteText, levelCompleteIdx] = pick("level_complete");
          speak("level_complete", levelCompleteIdx);
          // Mansion rooms open on block-completion progress alone -- see
          // CastleState.unlockForProgress. Response-blind like every other
          // award here: it only ever sees a completed-block COUNT.
          castle.unlockForProgress(blocksDone, rooms);
          // Guests move house at every block boundary, so the mansion is
          // never quite the same twice and a room the child has finished
          // decorating still has something new in it. Response-blind on the
          // same argument as unlockForProgress above: an rng and a block
          // COUNT, fired on a boundary, never inside one. Its own stream --
          // drawing from the trial stream would shift which triplets come
          // next, and from the shop stream it would depend on how much the
          // child had bought.
          castle.moveGuests(guestRng);
          // Fetch the grid's tiles while this screen is up, so the mansion
          // paints immediately rather than filling in tile by tile. Thumbs
          // are ~1KB each; the full-size art waits until a room is opened.
          prefetch(castle.mansion.filter((r) => r.unlocked)
            .map((r) => mansionBackdrop(r.index)), "thumb");
          const [mansionText, mansionIdx] = pick("mansion_prompt");
          speak("mansion_prompt", mansionIdx);
          return `<img class="pip" src="${mascot}" alt="">` +
                 `<p class="speech">${levelCompleteText ?? "Room finished!"}</p>` +
                 `<p class="awarded">${got.map(stickerHtml).join(" ")}</p>` +
                 `<div class="book">${bookHtml()}</div>` +
                 `<p class="speech">${mansionText ?? "Would you like to visit the mansion, or keep going?"}</p>`;
        },
        button: "🏰 Visit the mansion",
        // "Keep going!" skips the whole visit. Quiet rather than big: the
        // mansion is where the stickers just earned go, so it stays the
        // obvious next tap -- but a child who wants to carry straight on
        // must not have to walk through it to get back to the trials.
        quiet_button: "➡️ Keep going!",
        rest_button: "😴 Take a rest",
        on_finish: (d) => {
          breakChoice = { quiet: d.chose_quiet, rest: d.chose_rest };
          // "Keep going!" goes straight back to the trials, skipping both
          // screens below -- so this is the only place left that can stop the
          // track before one starts. (Rest stops it on its own way in; the
          // mansion stops it in finish().)
          if (breakChoice.quiet) stopMusic();
        },
      });

      // Wrapped in a conditional NODE, not left as a bare trial carrying a
      // conditional_function: that parameter is a timeline-node property, and
      // jsPsych ignores it on a plain trial object -- silently, since an
      // unknown key is not an error. Left bare, the rest screen ran on every
      // path, so "Visit the mansion" went through a rest first.
      timeline.push({
        timeline: [{
          type: ScreenPlugin,
          // Rest is quiet. It is the one screen in the game layer whose
          // whole purpose is less input, so the music stops here rather
          // than carrying over from the sticker screen -- and the child
          // goes straight back to the trials from here, where nothing may
          // be playing anyway.
          on_start: () => stopMusic(),
          // Open-ended: no timer, no countdown. A child who needs to stop
          // should not be watching a clock, and resting must never read as
          // failing -- see the desktop's _show_rest_screen.
          html: () => {
            const [restingText, restingIdx] = pick("resting");
            speak("resting", restingIdx);
            return `<img class="pip big-pip" src="${mascot}" alt="">` +
                   `<p class="speech">${restingText ?? "No problem -- take as long as you like."}</p>`;
          },
          button: "👍 I'm ready",
        }],
        conditional_function: () => breakChoice.rest,
      });

      const mansionTrial = {
        type: MansionPlugin,
        mansion: castle.mansion,
        spectators: arcadeSpectators,
        theme: manifest.theme ?? {},
        reduced_motion: Boolean(cfg.Gamify_Reduced_Motion),
        font_family: "PipUI",
        // The games' own rng stream, sibling of castle/backdrop/shop: a spawn
        // position drawn from the trial stream would shift which triplets the
        // child sees.
        game_rng: gameRng,
        catalog: shopCatalog,
        // Resolved once, like shopCatalog -- an invitation-letter purchase
        // draws from this pool live, in the shop, same as a mystery box.
        animal_pool: manifest.animals?.pool?.map((a) => animalItem(a.id)) ?? [],
        shop_rng: shopRng,
        prompt: "Which room shall we visit?",
        mascot: mascotHappy,
        currency_icon: currencyIcon,
        // One object, not ten function parameters -- see MansionPlugin.api.
        api: {
          pocket: () => castle.unplacedStickers()
            .map((id) => ({ ...sticker(id), kind: "sticker" }))
            .concat(shop ? castle.unplacedFurniture(shop.owned_furniture)
              .map((id) => ({ ...furnitureItem(id), kind: "furniture" })) : []),
          placedIn: (roomIdx) => castle.placedInRoom(roomIdx)
            .map((p) => ({ ...sticker(p.sticker_id), x: p.x, y: p.y, kind: "sticker" }))
            .concat(castle.furniturePlacedInRoom(roomIdx)
              .map((p) => ({ ...furnitureItem(p.sticker_id), x: p.x, y: p.y, kind: "furniture" }))),
          backdropFor: mansionBackdrop,
          // The animals living in a room. Resolved through animalItem() the
          // same way stickers and furniture are, so the room canvas gets one
          // shape ({emoji, img, x, y}) whatever kind of thing it is drawing.
          guestsIn: (roomIdx) => castle.guestsInRoom(roomIdx)
            .map((g) => ({ ...animalItem(g.animal_id), x: g.x, y: g.y, kind: "animal" })),
          // How many more rooms before a locked mansion room opens, for its
          // tile's countdown. Derived from the same thresholds
          // unlockForProgress uses, so the number on the tile and the rule
          // that actually opens the room cannot disagree.
          roomsToUnlock: (roomIdx) => {
            const i = castle.mansion.findIndex((r) => r.index === roomIdx);
            if (i < 0) return 0;
            const threshold = castle.unlockThresholds()[i] ?? 0;
            const needed = Math.ceil(threshold * rooms / 100);
            return Math.max(0, needed - blocksDone);
          },
          balance: () => coinBalance(),
          ownedFurniture: () => shop?.owned_furniture ?? [],
          ownedBackgrounds: () => shop?.owned_backgrounds ?? [],
          ownedAnimals: () => shop?.owned_animals ?? [],
          backgroundRoom: (itemId) => shop?.backgroundRoom(itemId),
          onEquip: (roomIndex, itemId) => shop?.equipBackground(roomIndex, itemId),
          furnitureVariants,
          spectators: arcadeSpectators,
          onScore: (n, key) => playSfx(n > 1 ? "level_up" : gameSound(key)),
          // The other half of the placement sound: a gesture that makes a
          // noise when it ENDS and none when it starts reads as unresponsive
          // for the whole time something is being carried. Same pairing the
          // desktop has (picked_up -> "pickup", placement -> "sticker").
          onPickUp: () => playSfx("pickup"),
          onPlace: (p) => {
            // Placing something ANYWHERE takes it out of the shared pocket, so
            // a move between rooms is a lift and a drop rather than a copy.
            castle.unplace(p.sticker_id);
            if (p.kind === "furniture") castle.placeFurniture(p.sticker_id, p.room_index, p.x, p.y);
            else castle.place(p.sticker_id, p.room_index, p.x, p.y);
            // Same cue a sticker's own reveal uses -- _on_item_placed's
            // `self.game.play("sticker")` (Python), on every placement, not
            // just the first time a sticker is earned.
            playSfx("sticker");
          },
          // Dragged back into the tray instead of re-placed -- the "pick it
          // up" half of a cross-room move; onPlace above is the "put it
          // down" half.
          onRetrieve: (id, kind) => {
            if (kind === "furniture") castle.unplaceFurniture(id);
            else castle.unplace(id);
            // Landing back in the pocket is an outcome and needs to sound
            // like one -- "pickup" already played when it was lifted, so the
            // gesture would otherwise end in silence and read as a drop that
            // did not take. A lighter chime than "sticker": going back into
            // the pocket is not a placement.
            playSfx("select");
          },
          onPurchase: (p) => {
            shop?.applyPurchase(p);
            // Every successful purchase makes a sound, the same one the
            // desktop plays (`if ok: self.game.play("sticker")`). shop_view
            // only records a purchase it actually completed, so reaching
            // here IS the success case.
            playSfx("sticker");
            // An invitation (or a mystery box that turned out to hold an
            // animal) buys the ANIMAL, not a spot for one -- the guest picks
            // its own room and its own place in it, right now, so the child
            // can go and find it. Drawn from the shop stream, never the trial
            // one: see CastleState.inviteGuest.
            if (p.won_item_type === "animal" && p.won_item_id) {
              castle.inviteGuest(p.won_item_id, shopRng);
            }
          },
          onRound: (play) => {
            const paid = castle.recordMinigame(play.game, play.room_index,
                                               play.score, play.duration_ms);
            if (paid) playSfx("level_up");
            return paid;
          },
        },
        on_finish: (d) => {
          castle.addPlaygroundTime(d.mansion_ms);
          castle.addMinigameTime(d.minigame_ms);
        },
      };
      // Skipped when the break screen's quiet button ("Keep going!") was
      // tapped, or when the child chose to rest instead (the rest screen
      // in between returns straight to the trials, not into the mansion).
      // A conditional NODE for the same reason the rest screen above is one --
      // conditional_function on the bare trial did nothing, so the mansion
      // opened even after "Keep going!".
      timeline.push({
        timeline: [mansionTrial],
        conditional_function: () => !breakChoice.quiet && !breakChoice.rest,
      });

    }
  });


  function bookHtml() {
    if (!castle) return "";
    const upcoming = castle.rooms.filter((r) => !r.completed)
      .flatMap((r) => r.sticker_ids).slice(0, castle.unearnedCount);
    return castle.awarded.map((id) =>
        `<span class="slot earned">${stickerHtml(sticker(id))}</span>`).join("") +
      upcoming.map((id) =>
        `<span class="slot mystery">${stickerHtml(sticker(id))}</span>`).join("");
  }

  /**
   * One small, non-interactive room per mansion room the child actually
   * decorated, laid out side by side. Port of _build_final_castle.
   *
   * Shows the child's OWN placements -- a finale that rearranged everything
   * into a tidy grid would quietly discard the only autonomy the game layer
   * offers. A locked room can never have anything in it; an unlocked-but-
   * empty one has nothing worth showing either, so both are skipped.
   *
   * Static markup, not mountRoomCanvas: the finale is display-only, and
   * pulling in that module's drag/tap gesture machinery for a screen
   * nothing can be picked up on would be dead weight. Sizes items as a
   * flat CSS percentage of the mini-room box rather than mountRoomCanvas's
   * measured-radius approach -- good enough for a thumbnail-scale recap.
   */
  function castleRevealHtml() {
    if (!castle) return "";
    const rooms = (castle.mansion || []).filter((r) => r.unlocked
      && (castle.placedInRoom(r.index).length || castle.furniturePlacedInRoom(r.index).length));
    if (!rooms.length) return "";
    const roomHtml = (r) => {
      const items = castle.placedInRoom(r.index)
        .map((p) => ({ ...sticker(p.sticker_id), x: p.x, y: p.y, cls: "" }))
        .concat(castle.furniturePlacedInRoom(r.index)
          .map((p) => ({ ...furnitureItem(p.sticker_id), x: p.x, y: p.y, cls: " furniture" })));
      const itemsHtml = items.map((it) =>
        `<span class="sticker mini${it.cls}" style="left:${it.x * 100}%;top:${it.y * 100}%;">`
        + `${stickerHtml(it)}</span>`).join("");
      const backdrop = mansionBackdrop(r.index);
      const style = backdrop ? ` style="background-image:url('${assetUrl(backdrop, "thumb")}')"` : "";
      return `<div class="mini-room"${style}>${itemsHtml}</div>`;
    };
    return `<div class="mini-rooms">${rooms.map(roomHtml).join("")}</div>`;
  }

  if (cfg.Gamify) {
    timeline.push({
      type: ScreenPlugin,
      html: () => `<p class="speech">Look at everything you made!</p>` +
                  castleRevealHtml() +
                  `<div class="book">${bookHtml()}</div>`,
      button: "🦝 Show Pip!",
    });
    pushCutscene("close", "Next");
    // The closing "All done!" screen is NOT a timeline item -- see
    // showAllDone() and initJsPsych's on_finish. A screen with a button is a
    // screen that can be dismissed, and there is nothing after this one.
  }

  jsPsych.run(timeline);
  hideLoadingOverlay();
})().catch((e) => {
  // A failure anywhere above leaves the loading overlay stranded on top of
  // this error screen -- it is only ever cleared by hideLoadingOverlay()
  // after a successful jsPsych.run(), which this path never reaches.
  document.querySelector(".loading-overlay")?.remove();
  document.getElementById("jspsych-target").innerHTML =
    `<div class="screen"><p class="speech">Could not start: ${e.message}</p>
     <p class="hint">Serve the repository over HTTP (see js/README.md); opening
     index.html directly from disk blocks the manifest loads.</p></div>`;
  console.error(e);
});
