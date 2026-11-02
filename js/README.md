# Pip's Castle — browser build (jsPsych)

A web port of the **Tier 1** (visual) and **Tier 2** (V / A / AV) triplet
odd-one-out tasks and their kid-facing game layer, for running the study at a
remote facility. Targets **jsPsych 8**.

## Run it

The page fetches manifests and images, so it must be served over HTTP.
Opening `index.html` from disk will fail (`file://` blocks `fetch`).

```bash
# from the repository root
python3 -m http.server 8000
# then open:
#   http://localhost:8000/
```

Opening it **without a query string** shows the experimenter's **setup screen**
— the browser counterpart to `experiments/setup_experiment.py`, with the same
fields: participant id, age, task tier, session length, the demographics, and
the gamified / reduced-motion switches. It previews the session it will run and
starts it on submit.

The participant id starts blank and is required: it seeds the triplets, the
block order and the reward schedule, so a blank or reused one would hand every
child an identical session.

### Session length

**One flat trial count per duration** — `short` 261, `standard` 523, `extended`
785 — the same at every age (`DURATION_TRIALS` in `js/src/session.js`, matching
`core/flexible_session_manager.py`'s `duration_trial_counts` — a test parses
one against the other, since a browser session and a lab session of the same
duration that disagree are not the same study). Only the block/room split
(`trials_per_block`, `num_blocks`) is still age-based; the total itself is not.

The three numbers are sized to the *blended average* pace across the four age
bins (5.5s/trial), not any one age's own pace, so they are not exactly right
for anyone: early childhood and middle childhood (slower than average) run
somewhat over the nominal duration, while adolescence and adults (faster than
average) finish with time to spare.

This replaced a per-age, per-duration calculation (age pace × requested
duration) that in turn replaced a flat count (550, unaffected by which
duration was picked) that in turn replaced an age-bin × duration table that
ran 16/24/32 for early childhood up to 350/600/800 for adults.

> Early childhood and middle childhood do **not** fit their nominal duration
> at any of the three settings: e.g. a `short` early-childhood session runs
> ~34 min of responding against a 24-effective-minute budget. Sessions run past
> their nominal duration or stop early on the time check. For young children
> the protocol answer is repeat sessions across days rather than one sitting.

**Tier 2 is capped by its own pacing.** Its A and AV blocks play three clips
before a choice is possible (~9.8s), so it costs ~9.2s a trial against ~3.5s
for a visual one. Feeding it the adult visual figure would schedule ~98 minutes
of playback into a 60-minute session, so it takes whichever is smaller — the
table, or what the clock holds. An adult standard Tier 2 session is 312 trials,
not 600.

That is the **session total**. It is split into blocks of **11 trials
(under 18)** or **25 (adults)** — a block boundary is where a room ends and its
stickers are awarded, so block size is really "how often is the child
rewarded", and it decides the room count:

| Age | Per block | Rooms |
|---|---|---|
| under 18 | 11 | 50 |
| 18+ | 25 | 22 |

The size cannot be picked freely: it must **divide 550** or the session lands
short, because rooms are what get scheduled and the division truncates. Since
550 = 2 × 5² × 11, the only options between 10 and 20 are 10 (55 rooms) and
11 (50 rooms). Under-18s were on 5, which meant 110 rooms — 110 sticker
ceremonies and playgrounds in a single session.

> **Stickers repeat at 50 rooms.** The pool is 104 and a room awards 2–4, so a
> 50-room session needs ~144 and `CastleState.create` reshuffles the pool when
> it runs dry — roughly 40 of them are second sightings. Avoiding repeats
> entirely needs ≤ ~34 rooms, i.e. 22 per block, which is outside the 10–20
> range. Adults at 22 rooms stay inside the pool.

Tier 2 runs **6 blocks, two per condition**, dividing its own (capped) total.

`trials` in the URL is trials **per block**, never the session total.

### Per-session settings, via the URL

A URL carrying `pid` skips the setup screen — that is the form for a facility
link, or for the test harness. `?setup=1` forces the form even so, and any
other params below preselect its fields.

```
http://localhost:8000/?pid=P07&rooms=6&trials=8&age=7&site=LabA
```

| Param | Meaning |
|---|---|
| `pid` | participant id — **seeds the whole session**, so it must be unique |
| `tier` | `1` (default, visual) or `2` (blocked V / A / AV) |
| `rooms` | number of castle rooms (`Num Blocks`); in Tier 2 one room = one condition block |
| `trials` | trials per room (`Num Trials`) |
| `age`, `site` | recorded into `participant_data` |
| `plain=1` | non-gamified baseline arm: no castle, no mascot |
| `calm=1` | reduced-stimulation mode |
| `upload=URL` | also POST the finished JSON to a collection endpoint |
| `mode` | Tier 2 only: `shared` (default) or `disjoint` — see below |
| `lead`, `gap` | Tier 2 stimulus pacing in ms (default 800 / 3000) |
| `duration` | `short`, `standard` (default) or `extended` — recorded; the trial count no longer varies with it |
| `setup=1` | show the setup screen even when `pid` is given |
| `child`, `response` | set by Children Helping Science — see below |
| `media=URL` | serve `assets/` and `datasets/` from another origin (needs CORS) |

Give neither `rooms` nor `trials` and both come from the session plan above.

> **A CHS link configures nothing but the child.** CHS appends `child=` and
> `response=` to whatever Study URL you set, so the researcher's parameters and
> a family's edit of them arrive in the same query string and are
> indistinguishable. On a deployment, therefore, a URL carrying `child=` gets
> its identity from CHS and *everything else* — `tier`, `plain`, `calm`,
> `quiet`, `age`, `site`, `mode`, `duration`, `lead`, `gap`, `rooms`, `trials`,
> `pid` — from the committed defaults in `js/src/config.js`. Change the arm or
> the tier for a CHS study by editing that file and deploying, not by writing a
> URL. (`upload=` is the exception, and is same-origin-only for everyone.) All
> of them still apply on a dev host, and on a lab link that carries no `child=`.

## Running it as a Children Helping Science study

CHS's own jsPsych runner cannot host this build: it forbids custom plugins, and
almost every screen here is one (`TripletPlugin`, `AudioTripletPlugin`,
`CutscenePlugin`, `PlaygroundPlugin`, `ScreenPlugin`). So it runs as a CHS
**external study** — CHS keeps recruitment, eligibility and consent, and links
out to this page.

**1. Host it.** This repo now ships a backend (`/api`, see "Hosting with a
backend" below) for the Turnstile bot gate and response storage, and GitHub
Pages cannot run it — Pages only serves static files. Deploy to
[Vercel](https://vercel.com) instead: "Add New… → Project", import this repo,
and accept the defaults (no framework, no build command — it is a static
site plus a handful of serverless functions under `/api`, which Vercel
detects on its own). `index.html` keeps its position above `assets/` and
`datasets/`, so the relative paths in `config.js` resolve unchanged. The
study is then at:

```
https://<project>.vercel.app/
```

(GitHub Pages still works for the static frontend alone — set `upload=` to
an external endpoint and skip the "Hosting with a backend" section — but then
there is no CAPTCHA gate and no built-in storage; that combination only makes
sense if you already have a collection endpoint elsewhere.)

**2. Set the Study URL** on the CHS study page — just the page itself. CHS
keeps your query string and appends its own, but on a deployment a CHS session
takes nothing from it (see the note above): `upload=` already defaults to this
deploy's own `/api/submit`, and the tier and the arm come from
`js/src/config.js`, where changing them is a commit rather than a link anyone
can retype.

```
https://<project>.vercel.app/
```

**3. What CHS sends.** When a family presses "Participate now", CHS appends the
hashed child id and the response id, and nothing else:

```
...?tier=1&upload=...&child=SG7JLN&response=d5c8f502-6588-46c8-84fa-a9657a44fe47
```

Seeing `child`, the build treats the session as a family at home: the
experimenter's setup form never appears (not even for `?setup=1`), the child
hash becomes the `participant_id` that seeds the session, `setting` is recorded
as `home`, and **no file download is offered** — a save prompt on a parent's
computer is not a data pipeline.

**4. Give it somewhere to put the data.** `upload_url` is therefore mandatory
for a CHS session: it is the only route out, and without it the session is
lost. It defaults to this deploy's own `/api/submit` (see "Hosting with a
backend" below) — only pass `?upload=` yourself to point at something else
instead. The endpoint receives the same JSON the desktop build writes.

**5. Age comes later, not from the link.** CHS does not put the child's age in
the URL, so `participant_data.age` is empty for these sessions. It lives in the
CHS demographic snapshot and is joined afterwards on `chs_child`, which is
recorded in every payload alongside `chs_response`. The analysis pipeline bins
by `participant_data.age`, so that join has to happen before
`analysis/spose_comparison.py` will bin these sessions by age.

> **Repeat participation.** The participant id is the child hash, which is
> stable — so a child who takes part twice replays the *same* triplet sequence.
> If repeat sessions should cover new triplets, seed from `chs_response`
> instead (one line in `applyUrlOverrides`).

## MELD consent/assent

Every session — lab, facility, and CHS alike — is gated on the MELD
(Multisensory Environments in Longitudinal Development) consent/assent forms
before it can start. `js/src/consent.js`'s `showConsentGate` picks the form(s)
by age:

| Age | Form(s) |
|---|---|
| 18+ | Adult Consent Form |
| 12–17 | Parental Consent Form + 12-17 Consent Form |
| 7–11 | Parental Consent Form + 7-11 Assent Form |
| 0–6 | Parental Consent Form + 0-6 Assent Form |

These bands are **not** `session.js`'s `AGE_BINS` — those cut at 10/11 for
trial-pacing reasons, MELD's forms cut at 11/12 (7-11 vs 12-17), so
`consent.js` has its own band function. A checkbox acknowledging the form(s)
were completed is required before Continue enables; the gate records
`consent_forms_shown`, `consent_acknowledged` and `consent_acknowledged_at`
into `participant_data`, matching the fields `experiments/setup_experiment.py`
writes into `session_config.json` (`MELD_Consent_Forms_Shown`,
`MELD_Consent_Acknowledged`, `MELD_Consent_Acknowledged_At`) on the desktop
build.

**CHS sessions ask a minimal age question first.** CHS never puts age in the
URL (see above), so the gate asks a single "what is your/your child's age?"
question before showing the link(s) — it does not bring back the full
experimenter setup form, which stays hidden for `child=` sessions. That answer
also becomes `cfg.Age` for the rest of the session, which fixes a previously
silent gap: CHS sessions used to build with an empty `Age` and fall through to
the adult trial-count plan; they now get the age-appropriate one from
`sessionPlan()` immediately, not only after the offline demographic join.

**Syncing a session to its REDCap consent record.** Each link is opened as
`<url>?pid=<participant_id>` — the same `participant_id` that seeds the
session and keys `participant_data`/the `sessions` table — so a REDCap
consent record can be joined back to a session afterwards. **This requires a
one-time REDCap-side setup**, done by whoever administers the MELD REDCap
project, for **each of the 5 instruments**:

1. Add a field (hidden/read-only is fine) to receive the piped value —
   e.g. `external_participant_id`.
2. Enable that field's URL auto-fill / parameter piping in Survey Settings, so
   a query parameter whose name matches the field's variable name is captured
   into the response. Without this step the `pid=` sits inert in the browser
   address bar and is never recorded on the REDCap side.
3. (Not implemented here.) Live completion-status sync back into this app —
   e.g. blocking Continue until REDCap itself confirms the record is
   complete — would need REDCap API credentials plus either polling or a Data
   Entry Trigger webhook. The current gate is a self-reported acknowledgement,
   not a verified one.

## Tier 2: the V / A / AV conditions

Tier 2 measures **supradditivity** — whether seeing-and-hearing an item
constrains similarity more than seeing plus hearing it separately. Two design
properties carry that measurement, and both are ported:

**Conditions are blocked and Latin-square counterbalanced.** One room = one
block = one condition, cycling the participant's order from
`LATIN_SQUARE_ORDERS`. The order actually run is recorded per room in
`game_state.castle.rooms[*].condition`, so it never has to be re-derived from
the id.

**`mode=shared` (default) yokes the triplets.** Every condition block presents
the *same* triplet list, so AV vs (V + A) is a within-item contrast. That
yoking is what makes the test well defined at item level. `mode=disjoint`
gives each block its own triplets: no cross-condition carryover, but
group-level comparison only.

Presentation follows the desktop build. Sounds auto-play in sequence — a
lead-in, then one clip every 3s — and every item keeps a **replay** button,
because sound is serial where an image is parallel: a child cannot re-listen
to sound 1 while sound 3 plays. Selecting stops playback *before* any
feedback, so a clip never runs under it. A-only items show a speaker and an
explicit "Pick this one"; AV items show the image and the whole card is the
target.

### The one thing a browser adds: autoplay

Chrome will not start playback on a page nobody has touched, and a blocked
A-only trial is a **silent** trial — the child picks from nothing and the row
looks like ordinary data. Two defences:

- `armPriming()` plays 0.05s of silence on the page's clicks until one
  unlocks the tab. Every session opens with screens the child taps, so this
  is resolved long before the first sound.
- If a `play()` still rejects, the screen falls back to "tap replay", and the
  row is flagged `stimulus_autoplay_blocked: true` so those trials can be
  **filtered rather than analysed**.

A/AV rows also carry `playback_ms`, the point at which the auto-play sequence
finished. `response_time_ms` matches the desktop build and is measured from
trial onset, so on these trials it is dominated by ~10s of forced playback;
decision time is `response_time_ms - playback_ms`. Both fields are additive
and ignored by the Python analysis.

## What comes out

The same JSON schema the desktop build writes, so
`analysis/spose_comparison.py`, `analysis/supradditivity_analysis.py` and
`analysis/vice_utils.py` read it **unchanged**:

```json
{
  "participant_data": { "...": "age, gamified, completion_status, ..." },
  "responses":        [ { "concept_triplet": [], "concept_selected": "", "...": "" } ],
  "game_state":       { "castle": { "...": "rooms, allocation, placements" } }
}
```

> **Downloaded and submitted are not the same document.** The file carries all
> three keys. What goes to `upload_url` is `participant_data` + `responses`
> only — the measurement and the demographics. `game_state` is the reward
> wrapper (stickers, placements, purchases, mini-game scores); no analysis
> reads it, and the desktop build's REDCap upload never sent it either, so it
> stays on the experimenter's disk rather than accumulating in a collection
> endpoint. `js/src/save.js`'s `forSubmission()` is the one place that decides.
> Tier 2's block order survives the drop — every response row carries its own
> `condition` and `block_number`.

Verified end to end: a payload built by `src/save.js` was parsed by
`analysis.vice_utils.responses_to_vice_format` and produced the expected
triplets, with attention trials correctly excluded.

The file downloads at the end, named exactly as the desktop build names it
(`tier<1|2>_<pid>_<stamp>.json`). Drop it into `data/responses/` and the existing
analysis picks it up. **Closing the tab partway still saves**, with
`completion_status: 0` and a `_partial` suffix — a child who disengages is
data, not a hole.

## Hosting with a backend (Turnstile + Postgres)

`/api` is three Vercel serverless functions: a bot gate, response storage, and
a researcher-only export. All three are optional in the sense that the study
runs fine without them configured (see "degrades ungated" below) — but a
public link with no bot gate and no server-side record of partial sessions is
not what you want for a real deployment.

**What each piece does:**

| | |
|---|---|
| `api/verify-start.js` | Verifies one Cloudflare Turnstile solve per session, mints a signed session ticket |
| `api/submit.js` | Stores a session's data (once at admission with no responses, once per completed room, and again at the end) into Postgres, gated on that ticket |
| `api/trial.js` | Stores each answered triplet the moment it is answered (the `trials` table), gated on that ticket, so a session abandoned mid-room keeps every answer |
| `api/export.js` | Lets *you* pull recorded sessions back out (`?trials=1` for per-trial rows, `?summary=1` for one line per participant), gated on a separate admin secret |
| `js/src/captcha.js` | Client side: renders the Turnstile widget, trades the solve for a ticket |

**Why a ticket, not the raw Turnstile token, on every upload.** Turnstile
tokens are single-use and expire in minutes; a session can run past an hour
for young children (see the pacing table above). So Turnstile is checked
**once**, at session start, and success mints an HMAC-signed ticket
(`api/_lib/ticket.js`) that every later `/api/submit` call carries instead.

**Why Postgres, not simpler object storage.** The payload carries a child's
age, gender, ethnicity, race, handedness and first language. Vercel Blob's
only access mode is "public" (anyone with the URL can read it, no
credential) — fine for images, wrong for this. Rows in Postgres are reachable
only through `/api/export`, which is the sole holder of the DB credential.

### Setup

1. **Create a Turnstile site** at
   [the Cloudflare dashboard](https://dash.cloudflare.com/?to=/:account/turnstile) →
   Turnstile → Add site. Use the **Managed** widget mode (usually solves
   itself with no interaction). You get a **site key** (public) and a
   **secret key** (not public).
2. **Add a Postgres database** to the Vercel project: project → Storage → Create
   Database → Postgres. Linking it to the project sets `POSTGRES_URL`
   automatically — nothing to copy by hand. The tables (`sessions`,
   `consent_files`) are created on first use; there is no separate migration
   step.
3. **Set environment variables** on the Vercel project (Settings →
   Environment Variables):

   | Variable | Value |
   |---|---|
   | `TURNSTILE_SECRET_KEY` | the secret key from step 1 |
   | `SESSION_TICKET_SECRET` | any long random string (e.g. `openssl rand -hex 32`) |
   | `ADMIN_EXPORT_SECRET` | any long random string, different from the one above |
   | `CONSENT_ENCRYPTION_KEY` | only if the consent-document upload is switched on (see below) |
   | `CONSENT_STORAGE_BUDGET_BYTES` | optional; defaults to 200MB (see below) |

   > **The consent-document upload is currently OFF.** The gate is an
   > acknowledgement — participants complete the forms in REDCap and tick a box,
   > and nothing is uploaded — so `/api/consent` and `/api/consent-export` are
   > dormant and `CONSENT_ENCRYPTION_KEY` is not needed to run the study. The
   > rest of this box applies only if you switch that path back on; see
   > `api/consent.js`'s header for what the client side needs.
   >
   > **`CONSENT_ENCRYPTION_KEY` cannot be recovered or rotated after the fact.**
   > Consent documents are encrypted with it before they reach Postgres
   > (`api/_lib/crypto.js`), and the key is deliberately not stored anywhere in
   > the database — that is what makes a database leak yield ciphertext rather
   > than signed forms. The consequence is symmetrical: **lose the key and every
   > stored consent form is permanently unreadable.** Put it wherever the
   > study's other irreplaceable credentials live before the first session runs.
   > Changing it later orphans everything stored under the old one, so export
   > and clear first (below) if it ever has to change.
   >
   > If it is missing or the wrong length, `/api/consent` returns 500 and
   > refuses the upload rather than storing the document in the clear.

4. **Put the site key in the client config**: `turnstile_site_key` in
   `js/src/config.js`. This one is *not* secret — it is meant to ship to the
   browser — so it can be committed directly.
5. Redeploy. A session now shows a brief "One moment…" gate before anything
   else loads.

**Degrades ungated, deliberately, when `turnstile_site_key` is blank** — e.g.
local dev via `python3 -m http.server`, or a checkout with no Vercel project
behind it at all. A **configured** deploy that then hits a broken backend
(CDN unreachable, `TURNSTILE_SECRET_KEY` unset) fails **closed** instead — see
`js/src/captcha.js`'s docstring for the distinction. Either way `/api/submit`
enforces its own ticket check regardless of what the client believes, so a
crafted request straight to the API without ever solving Turnstile is
rejected there too.

### Getting the data back out

```bash
curl -H "Authorization: Bearer $ADMIN_EXPORT_SECRET" \
  "https://<project>.vercel.app/api/export" > sessions.json
```

Returns the single most-complete row per participant (highest id — every
row's payload already contains every response so far, not just one block's,
so the latest row is always the fullest available). Add `?all=1` to get every
block-by-block row instead, or `?participant_id=P07` to filter to one
participant. Each row's `payload` field is the same JSON `data/responses/`
already expects — save it there under whatever filename convention you use
locally, same as a downloaded file would be.

### Getting the consent forms back out

> **Dormant.** Nothing uploads documents at present — the gate is a tick box and
> the signed forms live in REDCap, reachable there by `participant_id`. This
> section describes `/api/consent-export`, which is kept for a future version
> and which reports an empty table until the upload path is switched back on.
> It is still what to reach for if the table *does* hold rows from when that
> path was live.

The documents are encrypted at rest and `/api/consent-export` is the only way
to read them. It needs `ADMIN_EXPORT_SECRET` **and** `CONSENT_ENCRYPTION_KEY`
— a session ticket is never enough, so a leaked ticket cannot reach another
family's paperwork.

```bash
# inventory only: who has which form, how big, when. No documents move.
curl -H "Authorization: Bearer $ADMIN_EXPORT_SECRET" \
  "https://<project>.vercel.app/api/consent-export"

# with the documents themselves, base64 in `content_base64`
curl -H "Authorization: Bearer $ADMIN_EXPORT_SECRET" \
  "https://<project>.vercel.app/api/consent-export?participant_id=P07&content=1"
```

Write one out with, e.g.:

```bash
jq -r '.files[0].content_base64' export.json | base64 -d > P07-parental.pdf
```

**Storage is bounded, and the bound protects the response data.** `consent_files`
shares a database with `sessions`, so documents that fill the quota would start
failing session INSERTs — losing measurements to paperwork. `/api/consent`
therefore refuses an upload once the table reaches
`CONSENT_STORAGE_BUDGET_BYTES` (default 200MB) and returns **507**, logging
loudly. The session itself continues: a consent form can be chased afterwards,
a child's half-hour cannot.

Rough capacity at the default: a signed PDF is typically 200KB–1MB, so ~200–500
documents, i.e. ~100–250 participants at two forms each. A 10MB phone photo is
allowed but eats twenty times the room. Re-attaching a form for the same
participant upserts, so corrections cost the difference rather than another
document.

To reclaim space, export **and** clear in one call — note it is a `POST`, and
`delete=1` requires `content=1` so nothing is destroyed that was not just handed
over:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_EXPORT_SECRET" \
  "https://<project>.vercel.app/api/consent-export?content=1&delete=1" > consent.json
```

Rows that fail to decrypt are reported in `undecryptable` and are **never**
deleted — an unreadable document is the last thing that should be thrown away.
Every response also carries `stored_bytes`, so the budget can be watched.

## The rule this port had to preserve

The odd-one-out task has **no correct answer** on regular trials. Feedback is
a function of the *act* of responding, never of *what* was chosen. In this
codebase, concretely:

- `afterResponseText()` takes no argument, so it cannot branch on the choice.
- The selection highlight is blue. Never green or red — those read as
  correct/incorrect to a child.
- `allocate()` and `completeRoom()` take a room count and a room index. A test
  asserts their signatures contain no response-shaped parameter.
- The whole sticker schedule is drawn at session start, before any response
  exists.

Breaking any of these does not throw. It quietly teaches children a
similarity structure and corrupts every embedding built from the data.

## Tests

```bash
node js/test/run.mjs        # 15 headless tests
node js/test/browser.mjs    # drives a full session of EACH tier in a DOM
```

`run.mjs` covers the parts that need no DOM: seeding reproducibility, triplet
pair coverage, the reward contract, the save schema, and the Tier 2 design
properties — Latin-square balance, yoking under `shared`, disjointness under
`disjoint`, and that shuffling never crosses a block.

One of those tests found a real defect. `hashSeed(pid) % 6` looks like a fine
way to pick a Latin square, but FNV-1a's low bits are poorly mixed for short,
near-sequential ids — `P1`, `P2`, `0001` — which is exactly what a facility
assigns. Over 264 realistic ids it put 52 on one order and 35 on another, and
over 200 ids it never produced one of the six orders **at all**: a silently
uncounterbalanced design. The index is now drawn from a dedicated mulberry32
stream, and the test asserts both coverage and spread.

## Verified

`browser.mjs` drives a whole session of each tier in **jsdom against the real
jsPsych**, importing the real `src/main.js` and clicking through every screen.
It reports trials recorded, `trial_index` range, condition/block order,
stimulus `play()` calls, rooms completed, and console errors.

That it imports `main.js` matters. The first version of this harness
re-implemented the timeline builder inside the test, so the two could drift —
and they did. The copy kept passing while the shipping code wrote **jsPsych's
global timeline index** into `trial_index`, because jsPsych reserves that
field name and overwrites whatever a plugin puts there. Saved rows were
numbered 5, 6, 7, 11, 12, 13, … — counting story screens and playgrounds —
where the desktop build numbers trials 0..N-1. Plugins now emit
`task_trial_index`, and the harness asserts the saved range.

The harness has caught page-level failures too: it found the page not loading
at all, because the CDN URL pointed at jsPsych's ESM build, whose bare imports
(`auto-bind`) no browser can resolve. jsDelivr's `/+esm` output is no better —
it still fetches dependencies from the CDN at runtime. `index.html` loads the
**standalone** build from `vendor/`, which works with no network.

### Confirmed in a real Chrome browser

Both tiers were driven in Chrome over `http://localhost:8000`: images and font
render, layout holds, the V / A / AV screens each present correctly, all 100
matched Tier 2 items resolve in **both** modalities (200 requests, no misses),
a clip decodes via WebAudio (2.00s, mono, 48 kHz), and a completed Tier 2
session downloads with `trial_index` 0..N-1 and conditions cleanly blocked.
The resulting JSON was then parsed by
`analysis.vice_utils.responses_to_vice_format` — the same two triplets came
back under all three conditions, with attention trials excluded — and read by
`analysis/supradditivity_analysis.py`, which split it V:3 / A:3 / AV:3.

**One check still needs a human**: that sound is actually audible. Browser
automation drives a background tab, and Chrome does not load or start media in
a hidden tab (`play()` never settles), so audible playback cannot be verified
from a script. Open a Tier 2 session in a foreground tab, click through to an
A block, and confirm you hear three clips in sequence and that the replay
buttons work.

## Differences from the desktop build

| | Desktop (PyQt) | Browser (this) |
|---|---|---|
| Tier 1 visual task | yes | yes |
| Tier 2 V / A / AV task | yes | yes |
| Tier 2 Latin-square block order | md5(pid) | mulberry32 — **different order per id** |
| Stimulus audio | QMediaPlayer | `<audio>`, plus autoplay unlock + blocked-trial flag |
| Game sound effects | QSoundEffect | `<audio>` via `src/sfx.js`, gated on stimulus playback |
| REDCap upload | yes | `upload=URL` POST instead |
| Cutscene cross-fade | yes | plain screens |
| Sticker silhouettes | alpha-mask shapes | CSS grayscale |
| Trial sequence for a given `pid` | Mersenne Twister | mulberry32 — **different** |

The seeding rows matter: the two builds seed differently, so the same
participant id does **not** produce the same triplets — nor, in Tier 2, the
same block order — in both. Within either build an id is fully reproducible.
`participant_data.platform` records which build wrote a file (`jspsych-web`),
and `game_state.castle.rooms[*].condition` records the order actually run, so
the arms can always be separated.

## Dependencies

None to install. jsPsych 8.2.1 is vendored at
`js/vendor/jspsych-8.2.1.browser.js` (standalone, ~77 KB) with its stylesheet
alongside, so the study runs with no network and no build step. To move to a
different version, replace that file with the same `dist/index.browser.min.js`
build — **not** the ESM one, for the reason above.

`js/test/browser.mjs` needs `jsdom`, which is a dev-only dependency:

```bash
cd js && npm install --no-save jsdom
```
