"""Download everything the SONA deploy has stored, as JSON, into tools/out/.

Four files:
  summary.json   one line per participant (what sona_credit_report.py reads)
  credits.json   the auto-credit ledger: granted / refused / failed, and why
  sessions.json  each participant's most complete save -- it holds every
                 response so far, so the earlier room-end rows add nothing
  trials.json    every per-trial row (sessions deployed from 2026-11-02 on)

sessions and trials are fetched one participant at a time. Asked for in one
request they are the whole study's responses at once, which outgrows both the
database's HTTP response limit and Vercel's 4.5 MB function response cap --
?all=1 already fails that way (502 "storage unavailable").

The secret is read from ADMIN_EXPORT_SECRET in the environment, or else from
the repo's .env.local (gitignored), so it never has to be typed into a command
line or a chat:

    echo 'ADMIN_EXPORT_SECRET=...' > .env.local
    python3 tools/fetch_sona_data.py

tools/out/ is gitignored and excluded from the deploy: this repository is public.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parent
DEFAULT_URL = "https://chs-ooo-sona.vercel.app"



def read_secret():
    secret = os.environ.get("ADMIN_EXPORT_SECRET")
    source = "the shell environment"
    env_file = REPO_ROOT / ".env.local"
    if not secret and env_file.exists():
        source = str(env_file)
        for line in env_file.read_text().splitlines():
            key, _, value = line.partition("=")
            if key.strip() == "ADMIN_EXPORT_SECRET":
                secret = value.strip().strip("'\"")
    if not secret:
        sys.exit(f"ADMIN_EXPORT_SECRET is not set and not in {env_file}")
    # Where the key came from and its length, never the key: a 401 is almost
    # always a stale exported variable shadowing the file, or a paste that
    # picked up extra characters.
    print(f"using ADMIN_EXPORT_SECRET from {source} ({len(secret)} characters)")
    return secret


def fetch(url, secret):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {secret}"})
    try:
        with urllib.request.urlopen(req) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        hint = " -- wrong ADMIN_EXPORT_SECRET?" if e.code == 401 else ""
        sys.exit(f"{url}: HTTP {e.code} {e.read().decode(errors='replace')[:200]}{hint}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--url", default=DEFAULT_URL, help="the SONA deploy")
    ap.add_argument("--output_dir", type=Path, default=TOOLS_DIR / "out")
    args = ap.parse_args()

    secret = read_secret()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    export = f"{args.url}/api/export"

    def write(name, data):
        out = args.output_dir / f"{name}.json"
        out.write_text(json.dumps(data, indent=1, default=str))
        print(f"{name:9s} {data['count']:>6} rows -> {out}")

    summary = fetch(f"{export}?summary=1", secret)
    write("summary", summary)
    write("credits", fetch(f"{export}?credits=1", secret))

    sessions, trials = [], []
    for p in summary["participants"]:
        pid = urllib.parse.quote(p["participant_id"])
        sessions += fetch(f"{export}?participant_id={pid}", secret)["sessions"]
        if p["trials_saved"]:
            trials += fetch(f"{export}?trials=1&participant_id={pid}", secret)["trials"]
    write("sessions", {"ok": True, "count": len(sessions), "sessions": sessions})
    write("trials", {"ok": True, "count": len(trials), "trials": trials})


if __name__ == "__main__":
    main()
