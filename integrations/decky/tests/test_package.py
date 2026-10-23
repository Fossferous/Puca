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


if __name__ == "__main__":
    unittest.main()
