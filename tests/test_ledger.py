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
        self.assertEqual(payload["page"], 1)
        self.assertEqual(payload["highestPage"], 1)
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

    def test_ledger_pages_keep_entries_and_summaries_isolated(self):
        page_one = self.create(amountCents=3000)
        page_two = self.create(type="income", amountCents=5000, ledgerPage=2)

        first = app.ledger_month_payload(2026, 8, 1)
        second = app.ledger_month_payload(2026, 8, 2)

        self.assertEqual([entry["id"] for entry in first["entries"]], [page_one["entry"]["id"]])
        self.assertEqual([entry["id"] for entry in second["entries"]], [page_two["entry"]["id"]])
        self.assertEqual(first["summary"]["expenseCents"], 3000)
        self.assertEqual(second["summary"]["incomeCents"], 5000)
        self.assertEqual(first["highestPage"], 2)
        self.assertEqual(second["highestPage"], 2)

    def test_cumulative_view_uses_all_months_but_stays_on_one_page(self):
        self.create(amountCents=3000, date="2026-07-01")
        self.create(type="income", amountCents=9000, date="2026-08-01")
        self.create(type="income", amountCents=5000, date="2026-06-01", ledgerPage=2)

        cumulative = app.ledger_month_payload(2026, 8, 1, scope="all")

        self.assertEqual(cumulative["scope"], "all")
        self.assertEqual(cumulative["summary"], {
            "incomeCents": 9000,
            "expenseCents": 3000,
            "balanceCents": 6000,
            "count": 2,
        })
        self.assertEqual({entry["date"] for entry in cumulative["entries"]}, {
            "2026-07-01", "2026-08-01",
        })

    def test_legacy_entry_without_page_defaults_to_first_page(self):
        created = self.create()
        raw = json.loads(app.LEDGER_FILE.read_text(encoding="utf-8"))
        raw["entries"][0].pop("ledgerPage", None)
        app.LEDGER_FILE.write_text(json.dumps(raw), encoding="utf-8")

        first = app.ledger_month_payload(2026, 8, 1)
        second = app.ledger_month_payload(2026, 8, 2)

        self.assertEqual(first["entries"][0]["id"], created["entry"]["id"])
        self.assertNotIn("ledgerPage", first["entries"][0])
        self.assertEqual(second["entries"], [])

    def test_page_unit_is_independent_and_blank_restores_rmb(self):
        saved = app.ledger_page_unit_update({
            "page": 3, "year": 2026, "month": 8, "unit": "块",
        })
        self.assertEqual(saved["payload"]["unit"], "块")
        self.assertEqual(saved["payload"]["highestPage"], 3)
        self.assertEqual(app.ledger_month_payload(2026, 9, 3)["unit"], "块")
        self.assertEqual(app.ledger_month_payload(2026, 8, 1)["unit"], "")

        cleared = app.ledger_page_unit_update({
            "page": 3, "year": 2026, "month": 8, "unit": "",
        })
        self.assertEqual(cleared["payload"]["unit"], "")
        self.assertEqual(cleared["payload"]["highestPage"], 1)
        self.assertEqual(json.loads(app.LEDGER_FILE.read_text(encoding="utf-8"))["pageUnits"], {})

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
            {"type": "expense", "amountCents": 10, "date": "2026-08-01", "ledgerPage": 0},
            {"type": "expense", "amountCents": 10, "date": "2026-08-01", "ledgerPage": 100},
        ]
        for body in invalid:
            with self.assertRaises(ValueError):
                app.ledger_entry_create(body)
            self.assertEqual(app.LEDGER_FILE.read_bytes(), before)
        for page in (0, 100, 1.5, "bad"):
            with self.assertRaises(ValueError):
                app.ledger_month_payload(2026, 8, page)
        with self.assertRaises(ValueError):
            app.ledger_month_payload(2026, 8, 1, scope="year")
        for unit in ("a" * 13, 12, "bad\nunit"):
            with self.assertRaises(ValueError):
                app.ledger_page_unit_update({"page": 1, "year": 2026, "month": 8, "unit": unit})

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
