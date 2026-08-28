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
        payload = app.ledger_full_payload()
        self.assertEqual(payload["version"], 1)
        self.assertEqual(payload["highestPage"], 1)
        self.assertEqual(payload["pageUnits"], {})
        self.assertEqual(payload["entries"], [])
        self.assertFalse(app.LEDGER_FILE.exists())

    def test_create_uses_integer_cents_and_returns_full_snapshot(self):
        expense = self.create()
        income = self.create(
            type="income", amountCents=500000, date="2026-08-20", note="稿费",
        )
        self.assertTrue(expense["entry"]["id"].startswith("le_"))
        self.assertIn("ledger", income)
        self.assertEqual([entry["id"] for entry in income["ledger"]["entries"]],
                         [income["entry"]["id"], expense["entry"]["id"]])
        self.assertEqual(income["ledger"]["highestPage"], 1)
        self.assertTrue(app.LEDGER_FILE.is_file())
        self.assertTrue(app.LEDGER_BACKUP_FILE.is_file())

    def test_optional_multiplier_changes_effective_amount_and_can_be_cleared(self):
        created = self.create(amountCents=3000, multiplier=10)
        entry_id = created["entry"]["id"]
        self.assertEqual(created["entry"]["multiplier"], 10)
        self.assertEqual(app._ledger_effective_amount(created["entry"]), 30000)

        cleared = app.ledger_entry_update({"id": entry_id, "multiplier": None})
        self.assertNotIn("multiplier", cleared["entry"])
        self.assertEqual(app._ledger_effective_amount(cleared["entry"]), 3000)

    def test_decimal_multiplier_rounds_final_amount_to_nearest_cent(self):
        expense = self.create(amountCents=101, multiplier=1.005)
        income = self.create(type="income", amountCents=1, multiplier=0.5)
        self.assertEqual(app._ledger_effective_amount(expense["entry"]), 102)
        self.assertEqual(app._ledger_effective_amount(income["entry"]), 1)

    def test_entries_keep_their_page_and_highest_page_is_shared(self):
        page_one = self.create(amountCents=3000)
        page_two = self.create(type="income", amountCents=5000, ledgerPage=2)

        ledger = app.ledger_full_payload()
        by_id = {entry["id"]: entry for entry in ledger["entries"]}
        self.assertEqual(by_id[page_one["entry"]["id"]]["ledgerPage"], 1)
        self.assertEqual(by_id[page_two["entry"]["id"]]["ledgerPage"], 2)
        self.assertEqual(ledger["highestPage"], 2)

    def test_full_payload_covers_all_months_and_pages(self):
        self.create(amountCents=3000, date="2026-07-01")
        self.create(type="income", amountCents=9000, date="2026-08-01")
        self.create(type="income", amountCents=5000, date="2026-06-01", ledgerPage=2)

        ledger = app.ledger_full_payload()

        self.assertEqual(len(ledger["entries"]), 3)
        self.assertEqual({entry["date"] for entry in ledger["entries"]}, {
            "2026-07-01", "2026-08-01", "2026-06-01",
        })

    def test_legacy_entry_without_page_defaults_to_first_page(self):
        created = self.create()
        raw = json.loads(app.LEDGER_FILE.read_text(encoding="utf-8"))
        raw["entries"][0].pop("ledgerPage", None)
        app.LEDGER_FILE.write_text(json.dumps(raw), encoding="utf-8")

        ledger = app.ledger_full_payload()

        self.assertEqual(ledger["entries"][0]["id"], created["entry"]["id"])
        self.assertNotIn("ledgerPage", ledger["entries"][0])
        self.assertEqual(app._ledger_page(None), 1)
        self.assertEqual(app._ledger_page(""), 1)

    def test_page_unit_is_independent_and_blank_restores_rmb(self):
        saved = app.ledger_page_unit_update({"page": 3, "unit": "块"})
        self.assertEqual(saved["ledger"]["pageUnits"], {"3": "块"})
        self.assertEqual(saved["ledger"]["highestPage"], 3)
        self.assertEqual(app.ledger_full_payload()["pageUnits"], {"3": "块"})

        cleared = app.ledger_page_unit_update({"page": 3, "unit": ""})
        self.assertEqual(cleared["ledger"]["pageUnits"], {})
        self.assertEqual(cleared["ledger"]["highestPage"], 1)
        self.assertEqual(json.loads(app.LEDGER_FILE.read_text(encoding="utf-8"))["pageUnits"], {})

    def test_future_entry_and_cross_month_update_keep_one_snapshot(self):
        created = self.create(date="2032-12-31")
        entry_id = created["entry"]["id"]
        updated = app.ledger_entry_update({
            "id": entry_id,
            "date": "2033-01-15",
            "type": "income",
            "amountCents": 9901,
            "note": "未来收入",
        })
        self.assertEqual(updated["entry"]["date"], "2033-01-15")
        self.assertEqual([entry["id"] for entry in updated["ledger"]["entries"]], [entry_id])

    def test_color_patch_and_delete(self):
        created = self.create()
        entry_id = created["entry"]["id"]
        colored = app.ledger_entry_update({"id": entry_id, "color": "#FCE2CC"})
        self.assertEqual(colored["entry"]["color"], "#fce2cc")
        deleted = app.ledger_entry_delete({"id": entry_id})
        self.assertEqual(deleted["deletedId"], entry_id)
        self.assertEqual(deleted["ledger"]["entries"], [])
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
                app._ledger_page(page)
        for unit in ("a" * 13, 12, "bad\nunit"):
            with self.assertRaises(ValueError):
                app.ledger_page_unit_update({"page": 1, "unit": unit})

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
