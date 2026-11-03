"""Compare the SONA adults' odd-one-out choices with the literature SPoSE model, the way spose-py scores the children.

Everything model-side comes from spose-py, imported READ-ONLY: its dataset
(embedding, dissimilarities, categories), its loader (``load_sessions``,
``trials_to_triplets``), its scorer (``model_eval.score_triplets``) and its RDM
fidelity (``pilot_rdm_fidelity``). Group rows are pooled exactly as
``eval_deve_by_age.py`` pools an age group -- participants who pass the
attention check, partial sessions included -- so the SONA row sits beside the
children's rows on equal terms. Nothing is written inside spose-py: run with
PYTHONDONTWRITEBYTECODE=1 so importing it leaves no .pyc files there either.

Adds what that script does not compute:
  - pair coverage over the 556 shown objects, and a simulated model observer
    on the SAME triplets: the rho a participant would reach if they chose
    exactly as SPoSE predicts, i.e. the ceiling this sampling allows;
  - 27-category RDMs (human vs. SPoSE), with split-half reliability;
  - human dissimilarity binned by SPoSE dissimilarity;
  - accuracy, response time and attention by room (fatigue).

    PYTHONDONTWRITEBYTECODE=1 python3 tools/analyze_sona.py

Writes tools/out/analysis/{sona_analysis.json, *.png, *.csv} (gitignored).
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy.io import loadmat
from scipy.stats import spearmanr

TOOLS_DIR = Path(__file__).resolve().parent
OUT_DIR = TOOLS_DIR / "out"
DEFAULT_SPOSE = TOOLS_DIR.parent.parent.parent / "DEVE" / "spose-py-fresh"

CEILING = 0.672   # Hebart et al. 2020 noise ceiling, 67.22%; spose-py's memo value
CHANCE = 1 / 3
AGE_GROUPS = {"6-7": (6, 7), "8-9": (8, 9), "10-14": (10, 14)}
SEED = 0


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--spose-repo", type=Path, default=DEFAULT_SPOSE)
    ap.add_argument("--sona-dir", type=Path, default=OUT_DIR / "human" / "sona_batch1")
    ap.add_argument("--stimuli", type=Path,
                    default=TOOLS_DIR.parent / "datasets" / "Tier1_THINGS_560" / "manifest.json")
    ap.add_argument("--output_dir", type=Path, default=OUT_DIR / "analysis")
    ap.add_argument("--sim-reps", type=int, default=20)
    ap.add_argument("--split-reps", type=int, default=200)
    return ap.parse_args(argv)


def load_group(folder, load_sessions):
    sessions = {}
    for path in sorted(Path(folder).glob("*.json")):
        sessions.update(load_sessions(path))
    return sessions


def group_row(sessions, ds, c2i, score_triplets, trials_to_triplets, fidelity, logits_fn, rng,
              reps=10):
    """One table row, pooled over the sessions given (already filtered).

    ``rho_cap`` is the rho a SPoSE-like observer reaches on this group's own
    triplets: rho grows with the number of trials, so a row is only comparable
    to another as a share of its own cap.
    """
    trials = [trials_to_triplets(s["responses"], c2i) for s in sessions]
    pooled = np.concatenate(trials)
    sc = score_triplets(ds.embedding, pooled)
    fid = fidelity(pooled, ds.dissim)
    cap = float(np.mean([fidelity(simulate_model_observer(pooled, ds.embedding, logits_fn, rng),
                                  ds.dissim)["spearman_rho"] for _ in range(reps)]))
    rts = np.array([r["response_time_ms"] for s in sessions for r in s["responses"]
                    if not r["is_attention_trial"]])
    att = [r for s in sessions for r in s["responses"] if r["is_attention_trial"]]
    return {
        "n": len(sessions), "trials": int(len(pooled)),
        "median_rt_s": round(float(np.median(rts)) / 1000, 2),
        "accuracy": round(sc["accuracy"], 3),
        "chance_to_ceiling": round((sc["accuracy"] - CHANCE) / (CEILING - CHANCE), 2),
        "rho": round(fid["spearman_rho"], 3),
        "rho_cap": round(cap, 3),
        "rho_share_of_cap": round(fid["spearman_rho"] / cap, 2),
        "attention_correct": int(sum(bool(r.get("correct")) for r in att)),
        "attention_total": len(att),
    }, pooled


def pair_counts(triplets):
    """{(i, j): [together, apart]} over unordered object pairs."""
    counts = {}
    for i, j, k in triplets:
        for pair, apart in (((i, j), 0), ((i, k), 1), ((j, k), 1)):
            key = (min(pair), max(pair))
            c = counts.setdefault(key, [0, 0])
            c[apart] += 1
    return counts


def simulate_model_observer(triplets, X, logits_fn, rng):
    """Re-answer each shown triplet by sampling SPoSE's own choice probabilities."""
    obj = np.sort(triplets, axis=1)           # forget the human answer, keep the three objects
    logits = logits_fn(X, obj)                # pair (0,1), (0,2), (1,2) kept together
    p = np.exp(logits - logits.max(1, keepdims=True))
    p /= p.sum(1, keepdims=True)
    pick = (rng.random(len(p))[:, None] > np.cumsum(p, 1)).sum(1)
    a, b, c = obj[:, 0], obj[:, 1], obj[:, 2]
    return np.stack([np.where(pick == 2, b, a), np.where(pick == 0, b, c),
                     np.where(pick == 0, c, np.where(pick == 1, b, a))], axis=1)


def category_rdm(counts, cats_of, n_cat):
    apart = np.zeros((n_cat, n_cat))
    total = np.zeros((n_cat, n_cat))
    for (i, j), (tog, ap) in counts.items():
        for a in cats_of[i]:
            for b in cats_of[j]:
                for x, y in ((a, b), (b, a)):
                    apart[x, y] += ap
                    total[x, y] += tog + ap
    with np.errstate(invalid="ignore"):
        return apart / total, total


def plot_rdms(out_dir, ds, shown, counts, human_cat, model_cat, names, rho_cat, out):
    """Human vs. SPoSE, at the object level (556, sparse) and the category level (27)."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from scipy.cluster.hierarchy import leaves_list, linkage
    from scipy.spatial.distance import squareform

    # One order for both panels: SPoSE's own clustering, so blocks line up.
    D = ds.dissim[np.ix_(shown, shown)].copy()
    np.fill_diagonal(D, 0)
    order = leaves_list(linkage(squareform(D, checks=False), "average"))
    pos = {shown[o]: n for n, o in enumerate(order)}
    H = np.full((len(shown), len(shown)), np.nan)
    for (i, j), (tog, ap) in counts.items():
        if i in pos and j in pos:
            H[pos[i], pos[j]] = H[pos[j], pos[i]] = ap / (tog + ap)
    cmap = matplotlib.colormaps["viridis"].copy()
    cmap.set_bad("#e6e6e6")
    cov = out["coverage"]

    # Most pairs were seen once, so each raw cell is 0 or 1. Pooling 8 neighbours
    # (in SPoSE's order) per side shows whether the blocks are there at all.
    BIN = 8
    nb = -(-len(shown) // BIN)
    ap_b, tot_b = np.zeros((nb, nb)), np.zeros((nb, nb))
    for (i, j), (tog, ap) in counts.items():
        if i in pos and j in pos:
            a, b = pos[i] // BIN, pos[j] // BIN
            for x, y in {(a, b), (b, a)}:
                ap_b[x, y] += ap
                tot_b[x, y] += tog + ap
    with np.errstate(invalid="ignore"):
        Hb = ap_b / tot_b

    fig, ax = plt.subplots(1, 3, figsize=(16, 5.6), dpi=170)
    ax[0].imshow(H, cmap=cmap, vmin=0, vmax=1, interpolation="nearest")
    ax[0].set_title(f"SONA adults, raw choice RDM\n{cov['pct_observed']}% of {cov['pairs_possible']:,} pairs "
                    f"seen, {cov['pct_pairs_seen_once']}% of those once (grey = never)", fontsize=10)
    ax[1].imshow(Hb, cmap=cmap, vmin=0, vmax=1, interpolation="nearest")
    ax[1].set_title(f"SONA adults, pooled over {BIN}x{BIN}-object blocks\n(same order)", fontsize=10)
    im = ax[2].imshow(D[np.ix_(order, order)], cmap=cmap, vmin=0, vmax=1, interpolation="nearest")
    ax[2].set_title("Literature SPoSE dissimilarity\n(same 556 objects, same order)", fontsize=10)
    for a in ax:
        a.set_xticks([]), a.set_yticks([])
        a.set_xlabel("556 objects, ordered by SPoSE clustering", fontsize=9)
    fig.colorbar(im, ax=ax, shrink=0.8, label="dissimilarity (human: share of trials kept apart)")
    fig.suptitle(f"Object level: rho = {out['table']['SONA adults']['rho']:.3f} over observed pairs "
                 f"(a perfect SPoSE-like observer would reach {cov['model_observer_rho_mean']:.3f})",
                 fontsize=11)
    fig.savefig(out_dir / "rdm_objects.png", bbox_inches="tight")
    plt.close(fig)

    Dm = model_cat.copy()
    Dm = (Dm + Dm.T) / 2
    np.fill_diagonal(Dm, 0)
    corder = leaves_list(linkage(squareform(Dm, checks=False), "average"))
    labels = [names[c] for c in corder]
    fig, ax = plt.subplots(1, 2, figsize=(13, 6.2), dpi=170)
    for a, M, title in ((ax[0], human_cat, "SONA adults: share of trials kept apart"),
                        (ax[1], model_cat, "Literature SPoSE: mean dissimilarity")):
        im = a.imshow(M[np.ix_(corder, corder)], cmap="viridis", interpolation="nearest")
        a.set_xticks(range(len(labels)), labels, rotation=90, fontsize=7)
        a.set_yticks(range(len(labels)), labels, fontsize=7)
        a.set_title(title, fontsize=10)
        fig.colorbar(im, ax=a, shrink=0.75)
    c = out["category"]
    fig.suptitle(f"27 THINGS categories: human vs. SPoSE rho = {rho_cat:.2f} "
                 f"(human split-half reliability {c['reliability_spearman_brown']:.2f})", fontsize=11)
    fig.savefig(out_dir / "rdm_categories.png", bbox_inches="tight")
    plt.close(fig)


def main(argv=None):
    args = parse_args(argv)
    sys.path.insert(0, str(args.spose_repo))
    sys.path.insert(0, str(args.spose_repo / "pipeline" / "scripts" / "evaluation"))
    from eval_pilot_triplets import load_sessions, trials_to_triplets, pilot_rdm_fidelity
    from things_spose.analysis import model_eval
    from things_spose.core import paths
    from things_spose.data import dataio

    rng = np.random.default_rng(SEED)
    ds = dataio.load_dataset()
    c2i = {u: i for i, u in enumerate(ds.unique_id)}
    out = {}
    args.output_dir.mkdir(parents=True, exist_ok=True)

    # -- the group table, children recomputed from spose-py's own files --------
    kids = load_group(paths.CHILDREN_DIR, load_sessions)
    sona = load_group(args.sona_dir, load_sessions)
    passed = lambda ss: [s for s in ss if s["participant_data"].get("passes_attention_check")]
    rows = {}
    for g, (lo, hi) in AGE_GROUPS.items():
        members = passed([s for s in kids.values() if lo <= int(s["participant_data"]["age"]) <= hi])
        rows[g], _ = group_row(members, ds, c2i, model_eval.score_triplets, trials_to_triplets,
                               pilot_rdm_fidelity, model_eval.triplet_logits, rng)
    sona_pass = passed(sona.values())
    rows["SONA adults"], sona_tri = group_row(sona_pass, ds, c2i, model_eval.score_triplets,
                                              trials_to_triplets, pilot_rdm_fidelity,
                                              model_eval.triplet_logits, rng)
    out["table"] = rows
    out["sona_counts"] = {
        "imported": len(sona), "passed_attention": len(sona_pass),
        "completers": sum(s["participant_data"]["completion_status"] == 1 for s in sona.values()),
        "completers_passed": sum(s["participant_data"]["completion_status"] == 1
                                 for s in sona_pass),
    }

    # -- coverage of the 556 shown objects, and the ceiling this sampling allows --
    stim = json.loads(args.stimuli.read_text())
    stim = stim if isinstance(stim, list) else stim["concepts"]
    shown = sorted({c2i[e["concept_id"]] for e in stim})
    n_shown = len(shown)
    counts = pair_counts(sona_tri)
    per_pair = np.array([sum(v) for v in counts.values()])
    sims = [pilot_rdm_fidelity(simulate_model_observer(sona_tri, ds.embedding,
                                                      model_eval.triplet_logits, rng),
                               ds.dissim)["spearman_rho"] for _ in range(args.sim_reps)]
    out["coverage"] = {
        "objects_shown": n_shown, "pairs_possible": n_shown * (n_shown - 1) // 2,
        "pairs_observed": len(counts),
        "pct_observed": round(100 * len(counts) / (n_shown * (n_shown - 1) / 2), 1),
        "mean_obs_per_observed_pair": round(float(per_pair.mean()), 2),
        "pct_pairs_seen_once": round(100 * float((per_pair == 1).mean()), 1),
        "model_observer_rho_mean": round(float(np.mean(sims)), 3),
        "model_observer_rho_sd": round(float(np.std(sims)), 3),
        "human_rho_share_of_model_observer": round(rows["SONA adults"]["rho"] / float(np.mean(sims)), 2),
    }

    # -- 27-category RDMs ------------------------------------------------------
    m = loadmat(args.spose_repo / "data" / "spose" / "data" / "typicality_data27.mat")
    cat_names = [str(x.flat[0]) for x in m["categories27"].flat]
    cm = ds.category_mat_manual
    for word, cat in (("accordion", "musical instrument"), ("alpaca", "animal"), ("almond", "food")):
        assert cm[c2i[word], cat_names.index(cat)] == 1, f"category column order is not {cat_names}"
    cats_of = {i: list(np.flatnonzero(cm[i])) for i in shown}
    in_shown = [c for c in range(cm.shape[1]) if any(c in cats_of[i] for i in shown)]
    n_cat = cm.shape[1]
    human_cat, cat_total = category_rdm(counts, cats_of, n_cat)
    model_cat = np.full((n_cat, n_cat), np.nan)
    shown_arr = np.array(shown)
    for a in in_shown:
        ia = shown_arr[cm[shown_arr, a] == 1]
        for b in in_shown:
            ib = shown_arr[cm[shown_arr, b] == 1]
            block = ds.dissim[np.ix_(ia, ib)]
            if a == b:
                block = block[~np.eye(len(ia), dtype=bool)]
            model_cat[a, b] = block.mean()
    keep = [c for c in in_shown if cat_total[c, c] > 0]
    iu = np.triu_indices(len(keep), 1)
    sub = lambda M: M[np.ix_(keep, keep)]
    rho_cat, _ = spearmanr(sub(human_cat)[iu], sub(model_cat)[iu])
    within = np.nanmean(np.diag(sub(human_cat)))
    between = np.nanmean(sub(human_cat)[iu])

    # split-half: participants into two random halves, category RDM per half
    per_part = [trials_to_triplets(s["responses"], c2i) for s in sona_pass]
    halves = []
    for _ in range(args.split_reps):
        order = rng.permutation(len(per_part))
        h = [category_rdm(pair_counts(np.concatenate([per_part[i] for i in idx])), cats_of, n_cat)[0]
             for idx in (order[: len(order) // 2], order[len(order) // 2:])]
        a, b = sub(h[0])[iu], sub(h[1])[iu]
        ok = np.isfinite(a) & np.isfinite(b)
        halves.append(spearmanr(a[ok], b[ok])[0])
    r_half = float(np.mean(halves))
    out["category"] = {
        "categories_used": len(keep), "names": [cat_names[c] for c in keep],
        "rho_human_vs_spose": round(float(rho_cat), 3),
        "split_half_r": round(r_half, 3),
        "reliability_spearman_brown": round(2 * r_half / (1 + r_half), 3),
        "human_within_category_dissim": round(float(within), 3),
        "human_between_category_dissim": round(float(between), 3),
    }
    np.savez(args.output_dir / "category_rdms.npz", human=sub(human_cat), spose=sub(model_cat),
             names=np.array([cat_names[c] for c in keep]), total=sub(cat_total))

    # -- binned agreement: human "apart" rate by SPoSE dissimilarity decile ---------
    pairs = list(counts)
    lit = np.array([ds.dissim[i, j] for i, j in pairs])
    tog = np.array([counts[p][0] for p in pairs])
    apr = np.array([counts[p][1] for p in pairs])
    edges = np.quantile(lit, np.linspace(0, 1, 11))
    bins = np.clip(np.searchsorted(edges, lit, side="right") - 1, 0, 9)
    sim_counts = pair_counts(simulate_model_observer(sona_tri, ds.embedding,
                                                     model_eval.triplet_logits, rng))
    sim_apr = np.array([sim_counts.get(p, [0, 0])[1] for p in pairs])
    binned = []
    for b in range(10):
        sel = bins == b
        n = tog[sel] + apr[sel]
        binned.append({"decile": b + 1, "spose_dissim_mid": round(float(np.median(lit[sel])), 3),
                       "human_apart_rate": round(float(apr[sel].sum() / n.sum()), 3),
                       "model_observer_apart_rate": round(float(sim_apr[sel].sum() / n.sum()), 3),
                       "pairs": int(sel.sum())})
    out["binned"] = binned

    # -- by room: completers who passed attention ----------------------------
    rooms = {}
    for s in sona_pass:
        if s["participant_data"]["completion_status"] != 1:
            continue
        for r in s["responses"]:
            rooms.setdefault(r["block_number"], []).append(r)
    by_room = []
    for room in sorted(rooms):
        rr = rooms[room]
        reg = [r for r in rr if not r["is_attention_trial"]]
        att = [r for r in rr if r["is_attention_trial"]]
        acc = model_eval.score_triplets(ds.embedding, trials_to_triplets(reg, c2i))["accuracy"]
        by_room.append({"room": room + 1, "accuracy": round(acc, 3),
                        "median_rt_s": round(float(np.median([r["response_time_ms"] for r in reg])) / 1000, 2),
                        "attention_pct": round(100 * sum(bool(r.get("correct")) for r in att) / len(att), 1),
                        "trials": len(reg)})
    out["by_room"] = by_room

    # -- per participant: speed vs. agreement --------------------------------
    people = []
    for s in sona.values():
        pd = s["participant_data"]
        reg = [r for r in s["responses"] if not r["is_attention_trial"]]
        acc = model_eval.score_triplets(ds.embedding, trials_to_triplets(reg, c2i))["accuracy"]
        people.append({"complete": pd["completion_status"] == 1,
                       "passes_attention": bool(pd["passes_attention_check"]),
                       "median_rt_s": round(float(np.median([r["response_time_ms"] for r in reg])) / 1000, 2),
                       "accuracy": round(acc, 3), "trials": len(reg)})
    out["people"] = people

    plot_rdms(args.output_dir, ds, shown, counts, sub(human_cat), sub(model_cat),
              [cat_names[c] for c in keep], rho_cat, out)
    (args.output_dir / "sona_analysis.json").write_text(json.dumps(out, indent=1))
    print(json.dumps({k: v for k, v in out.items() if k not in ("people", "binned", "by_room")}, indent=1))
    print("binned:", [(b["decile"], b["human_apart_rate"], b["model_observer_apart_rate"]) for b in binned])
    print("by room:", [(r["room"], r["accuracy"], r["median_rt_s"], r["attention_pct"]) for r in by_room])


if __name__ == "__main__":
    main()
