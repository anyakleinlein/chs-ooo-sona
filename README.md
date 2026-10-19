# chs-ooo — Pip's Castle, odd-one-out task

Public hosting for a triplet **odd-one-out** study running on
[Children Helping Science](https://childrenhelpingscience.com/) as an *external*
study. This repository exists to be served: CHS requires study code and stimuli
to be reachable at a public URL, and this is that URL.

The study itself — analysis, session management, the PyQt lab build — lives in a
separate private repository. Nothing here is the analysis pipeline.

## The study

Children see three items and pick the one that doesn't belong. Judgments of this
form are what SPoSE/VICE embeddings are fitted to. Two tiers:

- **Tier 1** — visual: three images.
- **Tier 2** — three conditions, blocked and Latin-square counterbalanced:
  visual (**V**), audio (**A**), and audiovisual (**AV**).

A game layer wraps the task for young children: a mascot, a castle that fills
with stickers, and a playground between blocks. `?plain=1` turns all of it off
for the non-gamified baseline arm.

## Running it locally

The page fetches manifests and media, so it must be served over HTTP —
opening `index.html` from disk fails, because `file://` blocks `fetch`.

```bash
python3 -m http.server 8000
# then open http://localhost:8000/
```

This is for development only: there is no `api/` behind it, so uploads 404 and
the session runs ungated. See **Deploying** below for the real thing.

With no query string you get the experimenter's setup screen. See
[`js/README.md`](js/README.md) for the full parameter list, the session plan,
the Tier 2 design, and the CHS integration.

## Deploying

This repository is the deploy artifact: **Vercel** serves the static tree and
runs `api/` as serverless functions. `vercel.json` is the whole build config —
there is no build step, because there is nothing to build.

> **GitHub Pages cannot host this study.** Pages serves static files only, so
> `/api/submit` 404s there: the Turnstile gate never runs and **no session data
> is stored anywhere**. For a CHS family that endpoint is the only route out
> (no file download is offered at home), so a Pages deployment silently
> collects nothing. Point the CHS Study URL at Vercel, and disable Pages once
> it does, so there is no un-backed copy of the study still reachable.

**1. Import the repository.** [vercel.com/new](https://vercel.com/new) → import
`kefoto/chs-ooo`. Framework preset **Other**; leave Build Command and Output
Directory empty. Vercel serves the repo root and picks up `api/*.js`
automatically.

**2. Add Postgres and the environment variables**, then **3. create the
Turnstile site and paste its site key into `js/src/config.js`** — all three are
written out step by step, with what each variable is for, in
[`js/README.md`](js/README.md#hosting-with-a-backend-turnstile--postgres).
Until `turnstile_site_key` is filled in, every session runs **ungated**.

**4. Set the CHS Study URL** to the deployment root. The page is served from
the root here, so the link stays short, and CHS appends its own
`child`/`response` parameters to whatever query string you set:

```
https://<project>.vercel.app/?tier=1
```

**5. Check it end to end** before any family sees it: open that URL, confirm
the Turnstile gate appears, finish a short session
(`?rooms=2&trials=2&pid=SMOKE`), then pull it back out —

```bash
curl -H "Authorization: Bearer $ADMIN_EXPORT_SECRET" \
  "https://<project>.vercel.app/api/export?participant_id=SMOKE"
```

### Running it on SONA (the `anya/sona` branch)

This branch is deployed as its **own** Vercel project, with Production Branch
`anya/sona` and its own Postgres, so the CHS deploy from `main` is untouched.

- **SONA Study URL:** `https://<sona-project>.vercel.app/?sona=%SURVEY_CODE%`.
  The task and length come from `js/src/config.js`, never from the link.
- **Credit is granted by the server**, only after the final upload is stored
  and only for a completed, Turnstile-gated session of at least
  `SONA_MIN_MINUTES` (default 10). See `api/_lib/sona.js`.
- **Extra env vars:** `SONA_CREDIT_URL` = the study's *Server-Side*
  Completion URL with its literal `XXXX`; optionally `SONA_MIN_MINUTES`.
  `TURNSTILE_SECRET_KEY` is required: with the gate off, credit is refused.
- **Smoke test** with a `TEST…` code (`?sona=TEST42&rooms=2&trials=2`): it can
  be shortened, and can never be credited. Then check both halves:

```bash
curl -H "Authorization: Bearer $ADMIN_EXPORT_SECRET" \
  "https://<sona-project>.vercel.app/api/export?participant_id=TEST42"
curl -H "Authorization: Bearer $ADMIN_EXPORT_SECRET" \
  "https://<sona-project>.vercel.app/api/export?credits=1"
```

Any `refused` or `failed` row in the credit ledger needs granting by hand in
SONA.

### What `vercel.json` does

| Rule | Why |
|---|---|
| `/js/*` — `max-age=0, must-revalidate` | Code must never be served stale. A cached module is the failure mode that looks exactly like "the fix didn't deploy". |
| `/assets/*`, `/datasets/*` — `max-age=3600` + a week of `stale-while-revalidate` | Media is large and only changes on a sync, so the CDN keeps serving instantly while it refreshes behind the request. |
| `/api/*` — `no-store` | A cached upload response or a cached export would be wrong in both directions. |

## Layout

```
index.html   the page itself, served at /
js/          the jsPsych 8 build — timeline, plugins, game layer
assets/      mascot art, backdrops, stickers, cutscene panels, dialogue
datasets/    the stimuli: Tier1_THINGS_560/, Tier2_AV_Matched/
api/         the Vercel serverless functions (Turnstile gate, storage, export)
.nojekyll    serve the tree as-is, without Jekyll
```

### What this copy deliberately does NOT carry

Three things differ from the private repo on purpose, and a sync will try to
undo each. Check them by hand every time:

- **`index.html` sits at the ROOT here**, not at `js/index.html`, so the study
  URL is the bare origin. Only that file moved: it points at `js/vendor/`,
  `js/css/` and `js/src/`, and `config.js`'s `../assets/game` resolves to
  `/assets/game` from either location, so nothing else needed changing. A sync
  that copies `js/index.html` across will reintroduce the old layout — delete
  it and keep this one.

- **`assets/game/font/`** — the lab build's Fontworks display faces cannot be
  redistributed. This copy ships Nunito (SIL OFL) from `js/vendor/font/`
  instead, and `js/css/game.css`'s `@font-face` must keep pointing there.
- **`assets/game/music/*.wav` and `assets/game/voice/*.wav`** — 110 MB of
  24-bit PCM authored for the desktop build (whose QSoundEffect fallback
  decodes nothing else). This copy serves only the AAC derivatives under
  `assets/game/web/audio/`, which `js/src/assets.js` resolves to; the same
  audio at 5 MB. `assets/game/voice/voice_manifest.json` stays, because
  `js/src/voice.js` reads it to learn which lines have a recording.
  Regenerate the derivatives in the private repo with
  `python utilities/build_web_audio.py`.

## Credits and licensing

- **Tier 1 images** — the [THINGS database](https://things-initiative.org/).
- **Tier 2 audio** — the McDermott natural sounds set, trimmed to 2.0 s mono
  44.1 kHz.
- **Tier 2 images** — see
  [`datasets/Tier2_AV_Matched/image_attribution.json`](datasets/Tier2_AV_Matched/image_attribution.json).
- **Emoji-derived art** — see
  [`assets/game/emoji/ATTRIBUTION.txt`](assets/game/emoji/ATTRIBUTION.txt).
- **jsPsych 8.2.1** — MIT, vendored in `js/vendor/`.
- **Nunito** — SIL Open Font License, in `js/vendor/font/` with its
  [`OFL.txt`](js/vendor/font/OFL.txt). Latin subset only, since the dialogue is
  English.

**The display font differs from the lab build.** That build uses a Fontworks
face which is licensed and cannot be redistributed, so this public copy ships
Nunito in its place — rounded in the same spirit, and free to serve from a
public repository. `js/css/game.css` holds the `@font-face`.

Stimulus sets carry the terms of their original sources; check those before
reusing anything in `datasets/`.
