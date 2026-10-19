/**
 * The experimenter's setup screen, shown before the session starts.
 * Browser counterpart to experiments/setup_experiment.py.
 *
 * Same fields, same meanings, and the same live session preview -- so the
 * person running a remote session fills in what they would fill in at the lab
 * machine, rather than hand-assembling a query string.
 *
 *     When it appears
 *     ---------------
 *     Only when the URL does NOT already carry a participant id. A link with
 *     `?pid=...` is a session someone has already configured -- a facility
 *     link, or the test harness -- and stopping to ask a form would break it.
 *     `?setup=1` forces the form anyway.
 *
 * This screen is for the ADULT, never the child: it is plain, dense, and
 * deliberately unlike the game.
 */

import { sessionPlan, DURATIONS } from "./session.js";

const GENDER = ["", "Female", "Male", "Non-binary", "Prefer not to say"];
const HANDEDNESS = ["", "Right", "Left", "Ambidextrous"];
// Ethnicity is the Hispanic/Latino item and nothing else; race is the separate
// list below. Kept in the same order as field_mappings['ethnicity'] in
// experiments/setup_experiment.py, where the position IS the REDCap code.
const ETHNICITY = ["", "Hispanic or Latino", "Not Hispanic or Latino",
                   "Prefer not to answer"];
// Race, asked separately from ethnicity above -- they are two questions, and
// one is not a finer grain of the other. OMB/US Census categories. Kept in the
// same order as field_mappings['race'] in experiments/setup_experiment.py,
// where the position IS the REDCap code.
const RACE = ["", "American Indian or Alaska Native", "Asian",
              "Black or African American",
              "Native Hawaiian or Other Pacific Islander", "White",
              "Two or more races", "Prefer to self-describe",
              "Prefer not to answer"];
const RACE_SELF_DESCRIBE = "Prefer to self-describe";

const options = (values, selected) => values
  .map((v) => `<option value="${v}"${v === selected ? " selected" : ""}>` +
              `${v || "—"}</option>`)
  .join("");

/**
 * A fresh anonymous id, e.g. "P-7K2QX9MD". The alphabet drops 0/O and 1/I/L
 * so an id read aloud or copied by hand cannot be mistyped into another one.
 */
export function randomParticipantId() {
  const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return "P-" + Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

/** True when the session is already configured and the form should be skipped. */
export function setupNeeded(search = window.location.search) {
  const q = new URLSearchParams(search);
  // A CHS link is a family at home pressing "Participate now". There is no
  // experimenter to fill anything in, and this form asks for demographics CHS
  // already holds -- so it never appears, not even for ?setup=1.
  if (q.get("child")) return false;
  if (q.get("setup") === "1") return true;
  return !q.get("pid");
}

/**
 * Render the form and resolve with the chosen settings merged into `cfg`.
 * Never rejects: the only way out is Start, which always yields a session.
 */
export function showSetup(cfg, root, search = window.location.search) {
  // The id is never typed here. A SONA link already set it (applyUrlOverrides);
  // otherwise it is drawn fresh, as the lab build does. CONFIG's placeholder
  // ("WEB01") must never survive to Start: the id seeds the triplets, block
  // order and reward schedule, so a shared id gives everyone the same session.
  const urlPid = new URLSearchParams(search).get("pid");
  const pid = cfg.sona_id || urlPid || randomParticipantId();
  // A SONA participant fills this in about themselves, on their own computer.
  // The task and length are the study's, not theirs to pick: shorter means
  // credit for less, so those two controls are not rendered at all and the
  // session runs CONFIG's (applyUrlOverrides has already locked them).
  const sona = Boolean(cfg.sona_id);
  return new Promise((resolve) => {
    root.innerHTML = `
      <div class="setup">
        <h1>${sona ? "Before you begin" : "Session setup"}</h1>
        <p class="setup-sub">${sona
          ? "Please answer a few questions about yourself. Only your age is "
            + "required; anything else you would rather not answer can be left blank."
          : "Fill the blank fields in before handing the screen to the child."}</p>

        <div class="setup-grid">
          <label>${sona ? "Your age" : "Age"}
            <input id="s-age" type="number" min="3" max="99" required
                   value="${cfg.Age ?? ""}" autocomplete="off"></label>
          ${sona ? "" : `
          <label>Task
            <select id="s-tier">
              <option value="1" selected>Tier 1: Visual (THINGS 560)</option>
              <!-- Disabled for now, not removed: the option (and its
                   session-plan/analysis code) stays in place for when
                   Tier 2 is ready, it just cannot be picked yet. -->
              <option value="2" disabled>Tier 2: Multisensory (coming soon)</option>
            </select></label>
          <label>Session length
            <select id="s-duration">
              ${DURATIONS.map((d) => `<option value="${d}"` +
                `${d === cfg.Session_Duration ? " selected" : ""}>${d}</option>`).join("")}
            </select></label>`}

          <label>Gender
            <select id="s-gender">${options(GENDER, cfg.Gender)}</select></label>
          <label>Handedness
            <select id="s-hand">${options(HANDEDNESS, cfg.Handedness)}</select></label>

          <label>Ethnicity
            <select id="s-eth">${options(ETHNICITY, cfg.Ethnicity)}</select></label>
          <label>Race
            <select id="s-race">${options(RACE, cfg.Race)}</select></label>

          <label class="setup-wide">Self-describe
            <input id="s-race-self" type="text" value="${cfg.Race_Self_Describe ?? ""}"
                   placeholder="Only if &quot;Prefer to self-describe&quot; is selected"
                   autocomplete="off" disabled></label>

          <label>First language
            <input id="s-lang1" type="text" value="${cfg.First_Language ?? ""}"
                   placeholder="e.g. English" autocomplete="off"></label>
          <label>Other languages
            <input id="s-lang2" type="text" value="${cfg.Other_Languages ?? ""}"
                   placeholder="Comma-separated, blank if none"
                   autocomplete="off"></label>
        </div>

        <div class="setup-preview" id="s-preview"></div>
        <p class="setup-error" id="s-error" hidden></p>
        <button class="big" id="s-start">${sona ? "Continue" : "Start session"}</button>
      </div>`;

    const el = (id) => root.querySelector(id);
    const preview = el("#s-preview");
    const error = el("#s-error");

    const tier = () => (sona ? cfg.Tier : Number(el("#s-tier").value));
    const plan = () => sessionPlan(el("#s-age").value || 25,
                                   sona ? cfg.Session_Duration : el("#s-duration").value,
                                   tier());

    function refresh() {
      const p = plan();
      if (sona) {
        preview.innerHTML = `<span>This study takes about ${p.minutes} minutes. `
          + `Please do it in one sitting, in a quiet place.</span>`;
        return;
      }
      const tier2 = tier() === 2;
      preview.innerHTML =
        `<strong>Session preview</strong>` +
        `<span>Age group: ${p.bin.replace(/_/g, " ")}</span>` +
        `<span>Target: ${p.recommended} trials (${p.minutes} min)</span>` +
        `<span>Runs: <b>${p.perBlock} per room × ${p.blocks} rooms ` +
        `= ${p.total}</b> + ~10% attention checks</span>` +
        (tier2
          ? `<span>Blocks: 2 each of V / A / AV, Latin-square ordered</span>`
          : `<span>Every room is visual</span>`);
    }

    // The free-text box is live only while it has something to describe.
    // Clearing it on the way out matters: a description typed against
    // "Prefer to self-describe" and then left behind when the category changed
    // would be saved alongside a category that contradicts it.
    function syncRaceSelfDescribe() {
      const wanted = el("#s-race").value === RACE_SELF_DESCRIBE;
      el("#s-race-self").disabled = !wanted;
      if (!wanted) el("#s-race-self").value = "";
    }
    el("#s-race").addEventListener("change", syncRaceSelfDescribe);
    syncRaceSelfDescribe();

    ["#s-age", "#s-duration", "#s-tier"].map(el).filter(Boolean).forEach((input) => {
      input.addEventListener("input", refresh);
      input.addEventListener("change", refresh);
    });
    refresh();

    el("#s-start").addEventListener("click", () => {
      // Age is required, not defaulted -- consent.js's showConsentGate reads
      // it straight from here to pick the MELD form, and a silently-defaulted
      // adult age would risk gating a minor's session on the wrong form.
      const ageVal = el("#s-age").value;
      if (ageVal === "" || Number(ageVal) < 0 || !Number.isFinite(Number(ageVal))) {
        error.textContent = sona ? "Please enter your age to continue."
          : "Age is required: it decides the consent form and the session length.";
        error.hidden = false;
        el("#s-age").focus();
        return;
      }
      const p = plan();
      resolve({
        ...cfg,
        participant_id: pid,
        Age: el("#s-age").value,
        Tier: tier(),
        // A length the URL pinned survives the form; otherwise this preview's
        // plan is what runs.
        ...(cfg.session_length_pinned ? {} : {
          "Num Blocks": p.blocks,
          "Num Trials": p.perBlock,
        }),
        Session_Duration: p.duration,
        Gender: el("#s-gender").value,
        Handedness: el("#s-hand").value,
        Ethnicity: el("#s-eth").value,
        Race: el("#s-race").value,
        // Read through the category rather than straight off the box, so a
        // description can never outlive the option that invited it.
        Race_Self_Describe: el("#s-race").value === RACE_SELF_DESCRIBE
          ? el("#s-race-self").value.trim() : "",
        First_Language: el("#s-lang1").value.trim(),
        Other_Languages: el("#s-lang2").value.trim(),
        // Gamify/Gamify_Reduced_Motion are no longer offered on this form --
        // the arm is fixed for now (CONFIG's defaults: gamified, not
        // reduced-motion), not an experimenter's per-session choice. Left
        // out of this object entirely so `...cfg` above is what decides.
      });
    });
  });
}
