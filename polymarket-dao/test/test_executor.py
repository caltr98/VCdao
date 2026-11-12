import importlib.util
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("executor", Path(__file__).parents[1] / "scripts" / "execute.py")
executor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(executor)


class OrderPlanning(unittest.TestCase):
    def setUp(self):
        self.buy = {"market": 123, "token_id": 456, "shares": 100_000_000, "payment": 55_000_000}
        self.book = {"market": "0x7b", "asset_id": "456", "tick_size": "0.01", "min_order_size": "5"}

    def test_binds_outcome_and_caps_spend_including_fees(self):
        plan = executor.plan_order(self.buy, self.book)
        self.assertEqual(plan, {"token_id": "456", "side": "BUY", "amount": "55", "max_spend": "55", "max_price": "0.55", "order_type": "FOK"})

    def test_rounds_price_down_to_current_tick(self):
        self.buy["payment"] = 55_999_999
        self.assertEqual(executor.plan_order(self.buy, self.book)["max_price"], "0.55")

    def test_rejects_wrong_outcome_and_market(self):
        for key, value in [("asset_id", "789"), ("market", "0x99")]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                executor.plan_order(self.buy, {**self.book, key: value})

    def test_rejects_below_minimum(self):
        with self.assertRaises(ValueError):
            executor.plan_order(self.buy, {**self.book, "min_order_size": "101"})

    def test_rechecks_authorization_after_signing_and_before_submission(self):
        client, chain = Mock(), Mock()
        chain.approved_buy.return_value = {**self.buy, "payment": 1}
        with patch.object(executor, "validate_signed_order"), self.assertRaises(RuntimeError):
            executor.send_once(client, chain, "id", self.buy, {}, io.StringIO(), {})
        client.post_order.assert_not_called()

    def test_timeout_does_not_retry_submission(self):
        client, chain = Mock(), Mock()
        chain.approved_buy.return_value = self.buy
        client.post_order.side_effect = TimeoutError("Unknown outcome")
        with patch.object(executor, "validate_signed_order"), patch.object(executor, "asdict", return_value={}), patch.object(executor, "save_attempt"), self.assertRaises(TimeoutError):
            executor.send_once(client, chain, "id", self.buy, {}, io.StringIO(), {})
        self.assertEqual(client.post_order.call_count, 1)

    def test_lower_price_cannot_raise_the_approved_price(self):
        self.assertEqual(executor.plan_order(self.buy, self.book, "0.50")["max_price"], "0.50")
        for price in ["0.56", "0.501", "0"]:
            with self.assertRaises(ValueError):
                executor.plan_order(self.buy, self.book, price)

    def test_signed_order_must_buy_enough_shares_for_the_approved_wallet(self):
        buy = {**self.buy, "executor": "0x123"}
        signed = Mock(maker="0x123", token_id="456", side="BUY", order_type="FOK", maker_amount=55_000_000, taker_amount=100_000_000)
        executor.validate_signed_order(signed, buy)
        signed.taker_amount -= 1
        with self.assertRaises(ValueError):
            executor.validate_signed_order(signed, buy)

    def test_attempt_file_is_persisted_and_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "attempt.json"
            with path.open("x+") as journal:
                executor.save_attempt(journal, {"state": "attempt_started"})
            self.assertIn("attempt_started", path.read_text())
            with self.assertRaises(FileExistsError):
                path.open("x+")


if __name__ == "__main__":
    unittest.main()
