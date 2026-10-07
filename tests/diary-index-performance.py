"""Compare diary summaries with a Git baseline using a disposable diary library."""
import argparse
import json
import os
import re
import statistics
import subprocess
import sys
import tempfile
import time
from datetime import date, timedelta
from pathlib import Path
from unittest import mock


REPO = Path(__file__).resolve().parent.parent


def median_ms(operation, rounds):
    samples = []
    for _ in range(rounds):
        started = time.perf_counter()
        operation()
        samples.append((time.perf_counter() - started) * 1000)
    return {"medianMs": round(statistics.median(samples), 2),
            "samplesMs": [round(sample, 2) for sample in samples]}


def io_counts(operation):
    counts = {"bodyReads": 0, "pathStatCalls": 0}
    original_read = Path.read_text
    original_stat = Path.stat

    def read(path, *args, **kwargs):
        counts["bodyReads"] += 1
        return original_read(path, *args, **kwargs)

    def stat(path, *args, **kwargs):
        counts["pathStatCalls"] += 1
        return original_stat(path, *args, **kwargs)

    with mock.patch.object(Path, "read_text", read), mock.patch.object(Path, "stat", stat):
        operation()
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-ref", default="HEAD")
    parser.add_argument("--rounds", type=int, default=5)
    args = parser.parse_args()
    if args.rounds < 1:
        parser.error("rounds must be positive")
    baseline_ref = subprocess.check_output(
        ["git", "rev-parse", args.baseline_ref], cwd=REPO, text=True).strip()
    source = subprocess.check_output(
        ["git", "show", baseline_ref + ":app.py"], cwd=REPO).decode("utf-8")
    match = re.search(r"^def diary_index\(\).*?(?=^def _calendar_canvas_activity)",
                      source, re.MULTILINE | re.DOTALL)
    if not match:
        raise RuntimeError("baseline diary_index function was not found")
    with tempfile.TemporaryDirectory(prefix="relatum-diary-benchmark-") as temp:
        os.environ["RELATUM_DATA_ROOT"] = temp
        sys.path.insert(0, str(REPO))
        import app

        app.DIARY_DIR.mkdir(parents=True)
        namespace = dict(vars(app))
        exec(compile(match.group(), "baseline-diary-index", "exec"), namespace)
        baseline = namespace["diary_index"]
        results = []
        previous_count = 0
        body = "日常学习与工作记录。这是普通的日记正文。\n" * 350
        for count in (365, 2000):
            for index in range(previous_count, count):
                day = (date(2020, 1, 1) + timedelta(days=index)).isoformat()
                path = app.DIARY_DIR / (day + ".md")
                path.write_text('---\ntitle: "学习记录"\ndate: "' + day
                                + '"\ntags: []\nupdatedAt: "2026-10-07T12:00:00"\n---\n\n'
                                + body, encoding="utf-8", newline="")
            previous_count = count
            expected = baseline()

            def cold_index():
                with app.DIARY_INDEX_CACHE_LOCK:
                    app._DIARY_INDEX_CACHE.clear()
                return app.diary_index()

            assert cold_index() == expected, "optimized summaries must match the baseline"
            before = median_ms(baseline, args.rounds)
            cold = median_ms(cold_index, args.rounds)
            assert app.diary_index() == expected
            warm = median_ms(app.diary_index, args.rounds)
            results.append({
                "files": count, "bodyCharsPerFile": len(body),
                "totalBytes": sum(path.stat().st_size for path in app.DIARY_DIR.glob("*.md")),
                "baseline": {**before, **io_counts(baseline)},
                "optimizedCold": {**cold, **io_counts(cold_index)},
                "optimizedWarm": {**warm, **io_counts(app.diary_index)},
            })
        print(json.dumps({"baselineRef": baseline_ref, "rounds": args.rounds,
                          "results": results}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
