"""Cross-reference SONA's uncredited sign-ups against what the study stored, and say who to credit.

Two inputs:
  - the survey codes of the uncredited timeslots, copied out of SONA: a text
    file with one code per line, or a CSV export (the code column is found by
    name, or given with --sona-column);
  - the study's per-participant summary, /api/export?summary=1 -- fetched here
    with ADMIN_EXPORT_SECRET from the environment, or read from a saved copy
    with --summary.

Writes one row per SONA code with a verdict, and prints the counts:

  auto_credited     the server granted credit; if SONA still lists it as
                    uncredited, the SONA call is what needs checking
  completed         finished every planned trial, credit not granted -- grant
  partial           started and answered some trials -- decide by progress
  started_only      admitted (start row) but answered nothing
  no_data           nothing stored under this code at all

    python tools/sona_credit_report.py --sona uncredited.txt
    python tools/sona_credit_report.py --sona uncredited.csv --summary tools/out/summary.json

Output lands in tools/out/, which is gitignored: this repository is public.
"""
import argparse
import csv
import json
import sys
from datetime import datetime
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
OUT_DIR = TOOLS_DIR / "out"
DEFAULT_URL = "https://chs-ooo-sona.vercel.app"

COLUMNS = ["sona_code", "verdict", "completed", "minutes", "regular_in_last_save",
           "planned_regular", "answers_saved", "attempts", "credit_status", "credit_detail"]


def read_codes(path, column):
    path = Path(path)
    if path.suffix.lower() != ".csv":
        return [line.strip() for line in path.read_text().splitlines() if line.strip()]
    with path.open(newline="") as f:
        reader = csv.DictReader(f)
        headers = reader.fieldnames or []
        if column is None:
            matches = [h for h in headers if "code" in h.lower()]
            if len(matches) != 1:
                sys.exit(f"cannot tell which column holds the survey code: {headers} "
                         "-- pass --sona-column")
            column = matches[0]
        elif column not in headers:
            sys.exit(f"--sona-column {column!r} is not one of {headers}")
        return [row[column].strip() for row in reader if row[column].strip()]


def fetch_summary(base_url):
    sys.path.insert(0, str(TOOLS_DIR))
    from fetch_sona_data import fetch, read_secret
    return fetch(f"{base_url}/api/export?summary=1", read_secret())


def minutes_between(start, end):
    if not start or not end:
        return None
    parse = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
    return round((parse(end) - parse(start)).total_seconds() / 60, 1)


def verdict(p):
    if p is None:
        return "no_data"
    if p["credit_status"] == "granted":
        return "auto_credited"
    if p["completed"]:
        return "completed"
    if p["trials_saved"] or (p["regular_trials_in_saves"] or 0) > 0:
        return "partial"
    return "started_only"


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--sona", required=True, help="uncredited survey codes: .txt (one per line) or .csv")
    ap.add_argument("--sona-column", help="CSV column holding the survey code (default: the one named *code*)")
    ap.add_argument("--summary", help="saved /api/export?summary=1 JSON (default: fetch it)")
    ap.add_argument("--url", default=DEFAULT_URL, help="the SONA deploy")
    ap.add_argument("--out", default=str(OUT_DIR / "sona_credit_report.csv"))
    args = ap.parse_args()

    codes = read_codes(args.sona, args.sona_column)
    summary = json.loads(Path(args.summary).read_text()) if args.summary else fetch_summary(args.url)
    by_code = {p["participant_id"]: p for p in summary["participants"]}

    rows = []
    for code in codes:
        p = by_code.get(code)
        rows.append({
            "sona_code": code,
            "verdict": verdict(p),
            "completed": p["completed"] if p else "",
            "minutes": minutes_between(p["started"], p["last_activity"]) if p else "",
            "regular_in_last_save": p["regular_trials_in_saves"] if p else "",
            "planned_regular": p["planned_regular_trials"] if p else "",
            "answers_saved": p["trials_saved"] if p else "",
            "attempts": p["attempts"] if p else "",
            "credit_status": (p["credit_status"] or "") if p else "",
            "credit_detail": (p["credit_detail"] or "") if p else "",
        })

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(rows)

    counts = {}
    for r in rows:
        counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1
    print(f"{len(codes)} SONA codes, {len(by_code)} participants in the database")
    for v in ["auto_credited", "completed", "partial", "started_only", "no_data"]:
        print(f"  {v:14s} {counts.get(v, 0)}")
    # SONA codes the database has that the uncredited list does not: already
    # credited in SONA, a TEST code, or a list copied out incompletely.
    extra = sorted(set(by_code) - set(codes))
    if extra:
        print(f"  in the database but not in the SONA list: {len(extra)} ({', '.join(extra[:10])}"
              f"{', ...' if len(extra) > 10 else ''})")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
