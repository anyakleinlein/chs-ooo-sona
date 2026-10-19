/**
 * Session output, in the SAME schema the PyQt build writes.
 *
 * This is the point of the whole port. analysis/vice_utils.py reads
 * `responses[*].concept_triplet` / `selected_concept`, and the age-bin
 * analyses read `participant_data.age`. A browser build that emitted its own
 * shape would produce data the existing pipeline cannot touch, and the
 * facility's sessions would need a bespoke converter before anyone could look
 * at them.
 *
 *   {
 *     "participant_data": {...},
 *     "responses":        [...],
 *     "game_state":       {"castle": {...}}     // third top-level key
 *   }
 *
 * `game_state` is deliberately a THIRD top-level key, not nested inside
 * participant_data (REDCap uploads that field-by-field) and not on response
 * rows (vice_utils iterates those per trial).
 */

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fileStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_` +
         `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function buildPayload({ config, responses, castle, shop, startTime, completed }) {
  const attention = responses.filter((r) => r.is_attention_trial);
  const correct = attention.filter((r) => r.correct).length;
  const score = attention.length ? (correct / attention.length) * 100 : 100;

  const regular = responses.filter((r) => !r.is_attention_trial);
  const plannedRegular = (config["Num Blocks"] || 0) * (config["Num Trials"] || 0);

  const participant_data = {
    participant_id: config.participant_id || "unknown",
    tier: config.Tier || 1,
    total_trials: responses.length,
    start_time: startTime,
    end_time: stamp(),
    attention_accuracy: Math.round(score * 100) / 100,
    passes_attention_check: score >= 80.0,
    // 1 = finished, 0 = ended early. Partial sessions are filterable and are
    // never silently pooled with complete ones.
    completion_status: completed ? 1 : 0,
    planned_regular_trials: plannedRegular,
    completed_regular_trials: regular.length,
    age: config.Age ?? "",
    gender: config.Gender ?? "",
    handedness: config.Handedness ?? "",
    ethnicity: config.Ethnicity ?? "",
    // Race is a separate question from ethnicity, not a finer grain of it.
    // race_self_describe is only ever non-empty when race is
    // "Prefer to self-describe".
    race: config.Race ?? "",
    race_self_describe: config.Race_Self_Describe ?? "",
    first_language: config.First_Language ?? "",
    other_languages: config.Other_Languages ?? "",
    experiment_site: config["Experiment Site"] ?? "",
    setting: config.Setting ?? "",
    vr_exposure: config.VR_Exposure ?? "",
    screen_time: config.Screen_Time ?? "",
    gamified: Boolean(config.Gamify),
    mascot_variant: config.Gamify ? (config.Gamify_Mascot || "neutral") : null,
    // Distinguishes browser sessions from PyQt ones. The two builds seed
    // their RNGs differently, so triplet sequences are NOT comparable across
    // implementations even for the same participant id.
    platform: "jspsych-web",
    // Children Helping Science identity, when the session came in through a
    // CHS external-study link. `age` above is empty for those: CHS does not
    // put it in the link, and the demographic snapshot is joined on
    // chs_child afterwards. Null for lab and facility sessions.
    chs_child: config.chs_child ?? null,
    chs_response: config.chs_response ?? null,
    sona_id: config.sona_id ?? null,
    // MELD consent/assent -- which form(s) consent.js's showConsentGate
    // determined applied to this age, and whether the required "I confirm
    // it's been completed" acknowledgement was given. The join back to an
    // actual REDCap consent record is participant_id, piped onto each link's
    // URL as ?pid= (see js/README.md's REDCap setup checklist).
    consent_forms_shown: config.consent_forms_shown ?? [],
    consent_acknowledged: Boolean(config.consent_acknowledged),
    consent_acknowledged_at: config.consent_acknowledged_at ?? null,
  };

  const payload = { participant_data, responses };
  if (castle) {
    payload.game_state = { castle: castle.toJSON() };
    if (shop) payload.game_state.shop = shop.toJSON();
  }
  return payload;
}

/**
 * One response row, matching experiments/two_tier_experiment._record_response
 * FIELD FOR FIELD. The names are not arbitrary: vice_utils reads
 * `concept_selected` and `concept_similar_pair`, and an almost-right name
 * silently yields zero usable triplets rather than an error.
 */
export function makeResponse({
  trialIndex, concepts, selected, position, isAttention,
  rtMs, condition = "V", tier = 1, blockNumber = 0,
}) {
  // The similar pair is the two NOT selected, excluded by position so a
  // repeated id (attention trials) cannot drop the wrong one.
  const similarPair = concepts.filter((_, i) => i !== position);

  const row = {
    tier,
    condition,
    block_number: blockNumber,
    trial_index: trialIndex,
    concept_triplet: concepts,
    concept_selected: selected,
    concept_similar_pair: similarPair,
    selected_position: position,
    is_attention_trial: Boolean(isAttention),
    response_time_ms: Math.round(rtMs),
    timestamp: new Date().toISOString(),
  };

  if (isAttention) {
    // Correct answer is the concept that appears once. Scored for data
    // quality only; the child is never told.
    const counts = {};
    for (const c of concepts) counts[c] = (counts[c] || 0) + 1;
    const unique = Object.keys(counts).filter((c) => counts[c] === 1);
    row.correct = unique.length ? unique.includes(selected) : false;
  }
  return row;
}

export function filenameFor(payload) {
  const pd = payload.participant_data;
  const suffix = pd.completion_status === 1 ? "" : "_partial";
  return `tier${pd.tier}_${pd.participant_id}_${fileStamp()}${suffix}.json`;
}

/** Trigger a browser download. */
export function downloadPayload(payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)],
                        { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filenameFor(payload);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/**
 * What is SUBMITTED, as opposed to what is saved.
 *
 * The measurement is `responses` (the triplets) and `participant_data` (the
 * demographics the setup form and CHS collect). `game_state` is a record of
 * the reward wrapper around them -- which stickers were earned, where they
 * were placed, what the shop sold, how the mini-games went -- and nothing
 * downstream reads it: analysis/vice_utils.py takes responses and
 * participant_data, and so does the desktop build's REDCap upload
 * (utilities/redcap_utils.py's upload_to_redcap). So it stays in the file the
 * experimenter downloads and does not go to a collection endpoint, where it
 * would be the bulk of the bytes on a 50-room session and a standing store of
 * data no analysis asks for.
 *
 * Tier 2's block order is NOT lost with it. Every response row carries its
 * own `condition` and `block_number`, so the order actually run is still
 * recoverable from `responses` alone -- `game_state.castle.rooms[*].condition`
 * was a second copy of it, never the only one.
 *
 * Destructuring, not `delete`: a key added to buildPayload later is left out
 * of the upload until someone decides it belongs there, which is the safer
 * direction for a payload carrying a child's demographics.
 */
export function forSubmission(payload) {
  const { participant_data, responses } = payload;
  return { participant_data, responses };
}

/**
 * POST to a collection endpoint, if the config names one.
 *
 * `block` (a room index) marks a per-block checkpoint rather than the final
 * save -- travels as a header, not in the body, so the body stays the
 * submitted payload unchanged for every caller of upload_url (an external
 * collection endpoint has no reason to know or care about this build's
 * internal checkpoint/final distinction).
 *
 * The body is forSubmission(payload), not the payload: one rule for every
 * upload_url, so a third call site cannot be added that quietly ships the
 * game state to somebody's endpoint.
 */
export async function postPayload(url, payload, { ticket, block } = {}) {
  const headers = { "Content-Type": "application/json" };
  // The session-admission ticket from js/src/captcha.js -- api/submit.js
  // verifies it before it will store anything. A header, not a body field, so
  // the body stays exactly the JSON any collection endpoint is promised.
  if (ticket) headers.Authorization = `Bearer ${ticket}`;
  if (Number.isFinite(block)) headers["X-Session-Block"] = String(block);
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(forSubmission(payload)),
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  return res;
}
