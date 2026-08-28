import json
import tempfile
import unittest
from pathlib import Path

import app


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.original_file = app.LEDGER_FILE
        self.original_backup = app.LEDGER_BACKUP_FILE
        app.LEDGER_FILE = root / "ledger.json"
        app.LEDGER_BACKUP_FILE = root / "ledger.backup.json"

    def tearDown(self):
        app.LEDGER_FILE = self.original_file
        app.LEDGER_BACKUP_FILE = self.original_backup
        self.temp_dir.cleanup()

    def create(self, **changes):
        body = {
            "type": "expense",
            "amountCents": 1250,
            "date": "2026-08-18",
            "note": "午饭",
            "color": "",
        }
        body.update(changes)
        return app.ledger_entry_create(body)

    def test_missing_file_is_empty_and_not_written(self):
        payload = app.ledger_month_payload(2026, 8)
        self.assertEqual(payload["version"], 1)
        self.assertEqual(payload["entries"], [])
        self.assertEqual(payload["summary"], {
            "incomeCents": 0,
            "expenseCents": 0,
            "balanceCents": 0,
            "count": 0,
        })
        self.assertFalse(app.LEDGER_FILE.exists())

    def test_create_uses_integer_cents_and_builds_month_summary(self):
        expense = self.create()
        income = self.create(
            type="income", amountCents=500000, date="2026-08-20", note="稿费",
        )
        self.assertTrue(expense["entry"]["id"].startswith("le_"))
        self.assertEqual(income["months"]["2026-08"]["summary"], {
            "incomeCents": 500000,
            "expenseCents": 1250,
            "balanceCents": 498750,
            "count": 2,
        })
        self.assertTrue(app.LEDGER_FILE.is_file())
        self.assertTrue(app.LEDGER_BACKUP_FILE.is_file())

    def test_optional_multiplier_changes_display_amount_summary_and_can_be_cleared(self):
        created = self.create(amountCents=3000, multiplier=10)
        entry_id = created["entry"]["id"]
        self.assertEqual(created["entry"]["multiplier"], 10)
        self.assertEqual(created["months"]["2026-08"]["summary"]["expenseCents"], 30000)

        cleared = app.ledger_entry_update({"id": entry_id, "multiplier": None})
        self.assertNotIn("multiplier", cleared["entry"])
        self.assertEqual(cleared["months"]["2026-08"]["summary"]["expenseCents"], 3000)

    def test_decimal_multiplier_rounds_final_amount_to_nearest_cent(self):
        expense = self.create(amountCents=101, multiplier=1.005)
        income = self.create(type="income", amountCents=1, multiplier=0.5)
        summary = income["months"]["2026-08"]["summary"]
        self.assertEqual(expense["entry"]["multiplier"], 1.005)
        self.assertEqual(summary["expenseCents"], 102)
        self.assertEqual(summary["incomeCents"], 1)
        self.assertEqual(summary["balanceCents"], -101)

    def test_future_entry_and_cross_month_update_return_both_months(self):
        created = self.create(date="2032-12-31")
        entry_id = created["entry"]["id"]
        updated = app.ledger_entry_update({
            "id": entry_id,
            "date": "2033-01-15",
            "type": "income",
            "amountCents": 9901,
            "note": "未来收入",
        })
        self.assertEqual(set(updated["months"]), {"2032-12", "2033-01"})
        self.assertEqual(updated["months"]["2032-12"]["summary"]["count"], 0)
        self.assertEqual(updated["months"]["2033-01"]["summary"]["balanceCents"], 9901)

    def test_color_patch_and_delete(self):
        created = self.create()
        entry_id = created["entry"]["id"]
        colored = app.ledger_entry_update({"id": entry_id, "color": "#FCE2CC"})
        self.assertEqual(colored["entry"]["color"], "#fce2cc")
        deleted = app.ledger_entry_delete({"id": entry_id})
        self.assertEqual(deleted["deletedId"], entry_id)
        self.assertEqual(deleted["months"]["2026-08"]["entries"], [])
        with self.assertRaises(KeyError):
            app.ledger_entry_delete({"id": entry_id})

    def test_invalid_input_does_not_change_file(self):
        self.create()
        before = app.LEDGER_FILE.read_bytes()
        invalid = [
            {"type": "transfer", "amountCents": 10, "date": "2026-08-01"},
            {"type": "expense", "amountCents": 0, "date": "2026-08-01"},
            {"type": "expense", "amountCents": 12.5, "date": "2026-08-01"},
            {"type": "expense", "amountCents": 10, "date": "2026-02-30"},
            {"type": "expense", "amountCents": 10, "date": "2026-08-01", "color": "red"},
            {"type": "expense", "amountCents": 10, "date": "2026-08-01", "multiplier": 0},
            {"type": "expense", "amountCents": 10, "date": "2026-08-01", "multiplier": 1.23456},
            {"type": "expense", "amountCents": 10, "date": "2026-08-01", "multiplier": 1000001},
        ]
        for body in invalid:
            with self.assertRaises(ValueError):
                app.ledger_entry_create(body)
            self.assertEqual(app.LEDGER_FILE.read_bytes(), before)

    def test_corrupt_primary_is_preserved_and_valid_backup_recovers(self):
        self.create(note="上一份有效数据")
        valid = app.LEDGER_FILE.read_bytes()
        app.LEDGER_BACKUP_FILE.write_bytes(valid)
        app.LEDGER_FILE.write_text("{bad json", encoding="utf-8")

        loaded = app.load_ledger()

        self.assertEqual(loaded["entries"][0]["note"], "上一份有效数据")
        self.assertEqual(json.loads(app.LEDGER_FILE.read_text(encoding="utf-8"))["version"], 1)
        self.assertEqual(len(list(app.LEDGER_FILE.parent.glob("ledger.corrupt-*.json"))), 1)

    def test_incompatible_version_is_not_overwritten(self):
        raw = {"version": 99, "entries": []}
        app.LEDGER_FILE.write_text(json.dumps(raw), encoding="utf-8")
        with self.assertRaises(app.LedgerVersionError):
            app.load_ledger()
        self.assertEqual(json.loads(app.LEDGER_FILE.read_text(encoding="utf-8")), raw)


if __name__ == "__main__":
    unittest.main()
