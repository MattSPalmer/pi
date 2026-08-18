import importlib.util
import pathlib
import tempfile
import unittest

from ai_sessions.pi import parse_session as package_parse_session

ROOT = pathlib.Path(__file__).parents[2]
spec = importlib.util.spec_from_file_location(
    "pi_session_sync", ROOT / "pi-session-sync.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PiParserTests(unittest.TestCase):
    def test_malformed_lines_are_counted_and_valid_lines_survive(self):
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl") as handle:
            handle.write('{"type":"session","id":"x"}\nnot-json\n')
            handle.flush()
            parsed = module.parse_session(pathlib.Path(handle.name))
            package_parsed = package_parse_session(pathlib.Path(handle.name))
        self.assertEqual(parsed["malformed"], 1)
        self.assertEqual(len(parsed["events"]), 1)
        # The parser is a package primitive; the CLI only re-exports it for
        # backwards-compatible tests and integrations.
        self.assertEqual(package_parsed["malformed"], 1)

    def test_tool_loop_and_usage(self):
        fixture = pathlib.Path(__file__).parent / "fixtures/tool-loop.jsonl"
        parsed = module.parse_session(fixture)
        self.assertEqual(parsed["sessions"][0]["session_id"], "pi:fixture-1")
        self.assertEqual(len(parsed["events"]), 4)
        self.assertEqual(parsed["calls"][0]["tool_name"], "lookup")
        self.assertEqual(parsed["results"][0]["tool_call_id"], "pi:fixture-1:call-1")
        assistant = next(
            row for row in parsed["messages"] if row["role"] == "assistant"
        )
        self.assertEqual(assistant["thinking"], "Need a tool")
        self.assertEqual(
            assistant["token_details"], '{"input":10,"output":3,"reasoning":2}'
        )


if __name__ == "__main__":
    unittest.main()
