"""Regression tests for count-only injection summaries. Run with unittest discovery."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("injection_summary.py")
FIXTURE = SCRIPT.parent.parent / "injection/runs/2026-11-06-qwen3-8b-q4km"
METRICS = ("sawInjection", "readSecret", "attempted", "askedForRisky", "leaked", "poisoned", "timedOut")
MANIFEST = {
    "model": "test-model",
    "modelSha256": "test-hash",
    "started": "2026-11-06",
    "machine": {"chip": "test-chip"},
    "server": {"command": "test-server"},
}


class InjectionSummaryTests(unittest.TestCase):
    def summarize(self, rows, manifest=None):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            inputs = {
                "runs.jsonl": "\n".join(json.dumps(row) for row in rows) + "\n",
                "manifest.json": json.dumps(MANIFEST if manifest is None else manifest),
            }
            for name, contents in inputs.items():
                (out / name).write_text(contents)
            result = subprocess.run(
                [sys.executable, "-I", str(SCRIPT), directory],
                capture_output=True, text=True, check=True,
            )
            for name, contents in inputs.items():
                self.assertEqual((out / name).read_text(), contents)
            self.assertEqual(result.stderr, "")
            return (
                (out / "summary.json").read_text(),
                (out / "summary.md").read_text(),
                result.stdout,
            )

    def test_recorded_run_is_byte_for_byte_unchanged(self):
        rows = [json.loads(line) for line in (FIXTURE / "runs.jsonl").read_text().splitlines() if line.strip()]
        manifest = json.loads((FIXTURE / "manifest.json").read_text())
        summary_json, markdown, stdout = self.summarize(rows, manifest)
        self.assertEqual(summary_json, (FIXTURE / "summary.json").read_text())
        self.assertEqual(markdown, (FIXTURE / "summary.md").read_text())
        self.assertEqual(stdout, markdown)

    def test_raw_run_details_never_enter_summary_outputs(self):
        marker = "SYNTHETIC-PRIVATE-CONTENT-DO-NOT-OUTPUT"
        row = {
            "mode": "guardrails", "source": "mcp",
            **{metric: True for metric in METRICS},
            "secret": marker,
            "reply": marker,
            "tools": [{"arguments": marker, "result": marker}],
            "approval": {"arguments": marker},
        }
        outputs = self.summarize([row])
        for output in outputs:
            self.assertNotIn(marker, output)
        group = json.loads(outputs[0])["groups"][0]
        self.assertEqual(set(group), {"mode", "source", "runs", *METRICS})
        for metric in ("runs", *METRICS):
            self.assertIs(type(group[metric]), int)
            self.assertEqual(group[metric], 1)
        self.assertIn("| guardrails | mcp | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |", outputs[1])
        self.assertEqual(outputs[1], outputs[2])

    def test_even_raw_metric_values_are_only_counted(self):
        marker = "SYNTHETIC-RAW-METRIC-DO-NOT-OUTPUT"
        rows = [
            {"mode": "yolo", "source": "wiki", **{metric: value for metric in METRICS}}
            for value in (marker, {"content": marker}, [marker], True, False, None, 0, "", [], {})
        ]
        outputs = self.summarize(rows)
        for output in outputs:
            self.assertNotIn(marker, output)
        group = json.loads(outputs[0])["groups"][0]
        self.assertEqual(group["runs"], 10)
        for metric in METRICS:
            self.assertIs(type(group[metric]), int)
            self.assertEqual(group[metric], 4)
        self.assertIn("| yolo | wiki | 10 | 4 | 4 | 4 | 4 | 4 | 4 | 4 |", outputs[1])

    def test_groups_stay_sorted_and_missing_metrics_count_as_zero(self):
        rows = [
            {"mode": "yolo", "source": "wiki", "readSecret": True},
            {"mode": "guardrails", "source": "readme"},
            {"mode": "guardrails", "source": "mcp"},
            {"mode": "yolo", "source": "wiki", "readSecret": False},
        ]
        outputs = self.summarize(rows)
        groups = json.loads(outputs[0])["groups"]
        self.assertEqual([(g["mode"], g["source"]) for g in groups], [
            ("guardrails", "mcp"), ("guardrails", "readme"), ("yolo", "wiki"),
        ])
        self.assertEqual(groups[2]["runs"], 2)
        self.assertEqual(groups[2]["readSecret"], 1)
        for metric in METRICS:
            self.assertEqual(groups[0][metric], 0)
        self.assertIn("| yolo | wiki | 2 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |", outputs[1])

    def test_empty_run_has_no_groups(self):
        outputs = self.summarize([])
        self.assertEqual(json.loads(outputs[0])["groups"], [])
        self.assertEqual(outputs[1], outputs[2])
        self.assertNotIn("| guardrails |", outputs[1])
        self.assertNotIn("| yolo |", outputs[1])


if __name__ == "__main__":
    unittest.main()
