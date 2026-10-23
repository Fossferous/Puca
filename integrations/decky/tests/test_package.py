"""The zip Decky installs, without a Deck: python -m unittest discover -s tests

The first 0.1.0 zip kept only name, version and licence in its package.json.
Decky took the missing "type" to mean a legacy plugin, evaluated
dist/index.js as a script, and stopped at its first `export`: in Game Mode
the plugin never started. Nothing before the real Deck could see it.
"""
import importlib.util
import json
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)

_spec = importlib.util.spec_from_file_location("puca_package_script", os.path.join(PLUGIN, "scripts", "package.py"))
package = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(package)


def decky_load_type(package_json: bytes) -> str:
    """Decky's own rule, from decky_loader/plugin/plugin.py (3.2.8 to 3.3.0)."""
    pkg = json.loads(package_json)
    return "ESMODULE_V1" if pkg.get("type") == "module" else "LEGACY_EVAL_IIFE"


class ZipPackageJsonTests(unittest.TestCase):
    def setUp(self):
        with open(os.path.join(PLUGIN, "package.json"), encoding="utf-8") as f:
            self.source = json.load(f)

    def test_decky_imports_the_bundle_as_an_es_module(self):
        self.assertEqual(decky_load_type(package.zip_package_json(self.source)), "ESMODULE_V1")

    def test_it_carries_only_what_decky_reads(self):
        self.assertEqual(json.loads(package.zip_package_json(self.source)), {
            "name": self.source["name"],
            "version": self.source["version"],
            "license": self.source["license"],
            "type": "module",
        })

    def test_a_source_that_is_not_a_module_is_refused(self):
        for kind in (None, "commonjs"):
            pkg = {k: v for k, v in self.source.items() if k != "type"}
            if kind is not None:
                pkg["type"] = kind
            with self.subTest(type=kind), self.assertRaises(ValueError):
                package.zip_package_json(pkg)

    def test_the_bundle_check_tells_a_module_from_a_script(self):
        self.assertTrue(package.is_es_module(b"const index = 1;\nexport { index as default };\n"))
        self.assertFalse(package.is_es_module(b"(function () { var exported = 1; })();\n"))
        self.assertFalse(package.is_es_module(b"const s = 'not an export';\n  export_name();\n"))


class LineEndingTests(unittest.TestCase):
    """The same source makes the same zip on any machine: Git for Windows
    checks text out with CRLF, which would change the zip's SHA-256."""

    def test_text_goes_in_with_lf(self):
        for name in ("main.py", "py_modules/puca_cdp.py", "dist/index.js", "plugin.json", "LICENSE", "NOTICE",
                     "LICENSES/LGPL-2.1.txt", "update-key.json"):
            self.assertEqual(package.as_lf(name, b"a\r\nb\r\n"), b"a\nb\n", name)

    def test_anything_else_is_left_as_it_is(self):
        self.assertEqual(package.as_lf("assets/icon.png", b"\x89PNG\r\n\x1a\n"), b"\x89PNG\r\n\x1a\n")


class UpdateKeyTests(unittest.TestCase):
    """--update-key: what lets a published build install the next one."""

    N = "s" * 342  # 2048 bits, as base64url

    def _key_file(self, value) -> str:
        import tempfile
        f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
        with f:
            f.write(value if isinstance(value, str) else json.dumps(value))
        self.addCleanup(os.remove, f.name)
        return f.name

    def test_only_the_public_half_goes_in(self):
        key = package.read_update_key(self._key_file({"kty": "RSA", "n": self.N, "e": "AQAB", "d": "private", "p": "x"}))
        self.assertEqual(json.loads(key), {"kty": "RSA", "n": self.N, "e": "AQAB"})
        self.assertNotIn(b"private", key)

    def test_anything_else_is_refused(self):
        for bad in ({"kty": "EC", "n": self.N, "e": "AQAB"}, {"kty": "RSA", "n": self.N[:200], "e": "AQAB"},
                    {"kty": "RSA", "n": self.N + "+", "e": "AQAB"}, {"kty": "RSA", "e": "AQAB"}, [1], "{not json"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                package.read_update_key(self._key_file(bad))


if __name__ == "__main__":
    unittest.main()
