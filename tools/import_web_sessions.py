#!/usr/bin/env python3
"""Turn the Vercel export into one session file per participant, the layout spose-py's evaluation scripts read.

The web study (chs-ooo-sona, a jsPsych port of the desktop task) stores each
participant's most complete save in Postgres; its ``tools/fetch_sona_data.py``
writes them to ``sessions.json`` as ``{"sessions": [{"participant_id", "tag",
"payload"}, ...]}``, where ``payload`` is a session object in the SAME schema
the desktop build writes (``participant_data`` + ``responses``). Each payload
becomes one plain session file -- schema 1 of
``eval_pilot_triplets.load_sessions`` -- so every evaluation script that takes
``--pilot-dir`` / ``--data-dir`` reads the batch unchanged.

Files are named like the desktop build's: ``tier1_<pid>.json``, with a
``_partial`` suffix when the save is not a completed session (``tag`` other
than ``final``), so partial sessions stay visible in a directory listing.

Upstream quirks, checked here rather than trusted:
  - ``start_time`` is UTC but ``end_time`` is the participant's local clock in
    web sessions saved before the fix, so their difference is not a duration.
    Durations are taken from the per-response ``timestamp`` (all UTC) instead
    and written to ``participant_data.minutes_on_task``.
  - The export carries only the measurement; there is no ``game_state``.

Written OUTSIDE spose-py (tools/out/human/<batch>/, gitignored here), so that
repository is only ever read: point its scripts' ``--pilot-dir`` / ``--data-dir``
at the folder this writes.

Examples
--------
    python3 tools/import_web_sessions.py --exclude 100 --exclude 52017
    python3 tools/import_web_sessions.py --batch sona_batch2 --force
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
OUT_DIR = TOOLS_DIR / "out"

REQUIRED_PARTICIPANT = {"participant_id", "tier", "completion_status",
                        "planned_regular_trials", "completed_regular_trials",
                        "attention_accuracy", "passes_attention_check", "age"}
REQUIRED_RESPONSE = {"concept_triplet", "concept_selected", "concept_similar_pair",
                     "is_attention_trial", "response_time_ms", "timestamp"}


def check_schema(pid: str, session: dict) -> None:
    missing = REQUIRED_PARTICIPANT - set(session["participant_data"])
    if missing:
        raise ValueError(f"{pid}: participant_data missing {sorted(missing)}")
    for i, r in enumerate(session["responses"]):
        missing = REQUIRED_RESPONSE - set(r)
        if missing:
            raise ValueError(f"{pid}: response {i} missing {sorted(missing)}")


def minutes_on_task(responses: list[dict]) -> float:
    ts = sorted(datetime.fromisoformat(r["timestamp"].replace("Z", "+00:00")) for r in responses)
    return round((ts[-1] - ts[0]).total_seconds() / 60, 1)


def parse_args(argv=None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sessions", type=Path, default=OUT_DIR / "sessions.json",
                    help="sessions.json from chs-ooo-sona's tools/fetch_sona_data.py")
    ap.add_argument("--batch", default="sona_batch1", help="Folder name under tools/out/human/.")
    ap.add_argument("--exclude", action="append", default=[],
                    help="Participant id to leave out entirely, e.g. a test session (repeatable).")
    ap.add_argument("--force", action="store_true", help="Overwrite files already imported.")
    ap.add_argument("--dry-run", action="store_true")
    return ap.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    out_dir = OUT_DIR / "human" / args.batch
    rows = json.loads(args.sessions.read_text())["sessions"]

    written = skipped = 0
    for row in rows:
        pid, session = row["participant_id"], row["payload"]
        if pid in args.exclude or not session["responses"]:
            continue
        check_schema(pid, session)
        session["participant_data"]["minutes_on_task"] = minutes_on_task(session["responses"])
        tier = session["participant_data"]["tier"]
        suffix = "" if row["tag"] == "final" else "_partial"
        out = out_dir / f"tier{tier}_{pid}{suffix}.json"
        if out.exists() and not args.force:
            skipped += 1
            continue
        if not args.dry_run:
            out_dir.mkdir(parents=True, exist_ok=True)
            out.write_text(json.dumps(session, indent=1))
        written += 1

    verb = "would write" if args.dry_run else "wrote"
    print(f"{verb} {written}, skipped {skipped} existing (use --force), "
          f"excluded {len(args.exclude)} -> {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
