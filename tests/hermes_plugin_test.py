#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path


class MemoryProvider:
    pass


def tool_error(message: str) -> str:
    return f"ERROR:{message}"


agent_module = types.ModuleType("agent")
memory_provider_module = types.ModuleType("agent.memory_provider")
memory_provider_module.MemoryProvider = MemoryProvider
tools_module = types.ModuleType("tools")
registry_module = types.ModuleType("tools.registry")
registry_module.tool_error = tool_error
sys.modules.setdefault("agent", agent_module)
sys.modules["agent.memory_provider"] = memory_provider_module
sys.modules.setdefault("tools", tools_module)
sys.modules["tools.registry"] = registry_module

PLUGIN_PATH = Path(__file__).resolve().parents[1] / "plugins" / "zenos-memory" / "__init__.py"
SPEC = importlib.util.spec_from_file_location("zenos_memory_plugin_test_target", PLUGIN_PATH)
assert SPEC and SPEC.loader
PLUGIN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PLUGIN)


class ZenosMemoryPluginTests(unittest.TestCase):
    def setUp(self):
        self._temporary_directory = tempfile.TemporaryDirectory()

    def tearDown(self):
        self._temporary_directory.cleanup()

    def provider(self):
        provider = PLUGIN.ZenosMemoryProvider()
        provider._secret = "configured-for-test"
        provider._namespace = "zenos"
        provider._session_id = "session-test"
        provider._salience_batch_size = 2
        provider._salience_flush_seconds = 300
        provider._salience_spool_path = Path(self._temporary_directory.name) / "salience-spool.json"
        return provider

    def test_cross_language_continuity_fingerprint(self):
        fingerprint = PLUGIN._continuity_fingerprint([
            {"role": "user", "content": "Keep this decision."},
            {"role": "assistant", "content": {"b": 2, "a": "ok"}},
        ])
        self.assertEqual(
            fingerprint,
            "f09a327ce285a2205521cb4460f4f4cbfefe83677b2e7597a854f48b8d23d6b6",
        )

    def test_salience_writes_flush_as_one_idempotent_batch(self):
        provider = self.provider()
        calls = []

        def request(method, path, body=None, scopes=None, idempotency_key=None):
            calls.append({
                "method": method,
                "path": path,
                "body": body,
                "idempotency_key": idempotency_key,
            })
            return {"success": True, "count": len((body or {}).get("memories", []))}

        provider._request = request
        provider.sync_turn("Aku suka jawaban yang ringkas dan akurat.", "", session_id="s1")
        self.assertEqual(calls, [])
        provider.sync_turn("Kita putuskan tetap pakai Zenos Runtime untuk verifikasi.", "", session_id="s1")

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["path"], "/api/memory/remember-batch")
        self.assertEqual(len(calls[0]["body"]["memories"]), 2)
        self.assertRegex(calls[0]["idempotency_key"], r"^hermes-salience-batch:[a-f0-9]{64}$")
        self.assertTrue(all(item.get("idempotency_key") for item in calls[0]["body"]["memories"]))

    def test_duplicate_buffer_entries_collapse_and_shutdown_forces_flush(self):
        provider = self.provider()
        provider._salience_batch_size = 4
        calls = []
        provider._request = lambda method, path, body=None, scopes=None, idempotency_key=None: calls.append({
            "path": path,
            "body": body,
            "idempotency_key": idempotency_key,
        }) or {"success": True}

        message = "Aku suka hasil yang langsung menunjukkan bukti pengujian."
        provider.sync_turn(message, "", session_id="same")
        provider.sync_turn(message, "", session_id="same")
        self.assertEqual(len(provider._salience_buffer), 1)
        provider.shutdown()

        self.assertEqual(len(calls), 1)
        self.assertEqual(len(calls[0]["body"]["memories"]), 1)
        self.assertEqual(provider._salience_buffer, [])

    def test_salience_spool_survives_process_memory_loss(self):
        provider = self.provider()
        provider._salience_batch_size = 4
        provider.sync_turn("Aku suka jawaban yang menyertakan hasil test.", "", session_id="durable")
        self.assertEqual(len(provider._salience_buffer), 1)

        restarted = self.provider()
        restarted._salience_buffer = restarted._load_salience_spool()
        self.assertEqual(len(restarted._salience_buffer), 1)
        self.assertEqual(
            restarted._salience_buffer[0]["idempotency_key"],
            provider._salience_buffer[0]["idempotency_key"],
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
