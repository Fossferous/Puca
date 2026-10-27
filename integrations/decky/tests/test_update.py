"""The plugin's updates, without a Deck: python -m unittest discover -s tests

What the backend fetches (py_modules/puca_update.py), what Update downloads
(main.py, download_update), and the check every release passes before it is
published (scripts/verify_update.py): a second implementation of the
signature check the plugin makes with WebCrypto. The end-to-end cases sign
with the release script's own signer (scripts/signing.mjs, through Node), so
what is checked here is what releases are made with.
"""
import asyncio
import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(PLUGIN, "py_modules"))
sys.path.insert(0, os.path.join(PLUGIN, "scripts"))
sys.path.insert(0, PLUGIN)

# main.py imports puca_cdp, which imports aiohttp (Decky bundles it). Nothing
# here opens a connection, so a stand-in does when it is not installed.
try:
    import aiohttp  # noqa: F401
except ImportError:
    _stub = types.ModuleType("aiohttp")
    _stub.ClientSession = object
    _stub.ClientWebSocketResponse = object
    _stub.ClientError = Exception
    _stub.ClientTimeout = lambda **_: None
    _stub.WSMsgType = types.SimpleNamespace(TEXT=1)
    sys.modules["aiohttp"] = _stub

import puca_update as pu  # noqa: E402
import verify_update as vu  # noqa: E402

# A throwaway key, made for this test and used nowhere else: its public half,
# and its signature over the update text for version 0.2.0 and the SHA-256 of
# b"a release" (made with Node's crypto.sign).
VECTOR = {
    "n": "ss6lEvMWMf3YECqcXu_xY8Qdw5T8Ipky4iGLjDzFFTKNFagMwN_Ywdrepiz3GKeaAD62uaY4jGs8L-JFD1ESYDbQClx9WlIKmW8dpYKn2ctOLdof"
         "wcy1rghXKFAOl7Rzwq3TGax01Cx5pT7x9dqu8vLUTBEKMjbvoOfD_qM1R7QHz4ydClrexLjr8sJAsd93cx2VkE7EG_c-Irl9H0OkpEVjgnwgkLkL"
         "Z5-T-I10czd7khP2NBxxxNY54igAbPR7iLzyMk9cY9mDYWxdlyi-_9q8_GTuyESKB9pCYsWdbaYW6Jj6L2usvA1suv8ywUQ2rflYw30vtuKt_VWt0T6GrQ",
    "e": "AQAB",
    "sha": "e9edfb8e46f891370bda2772760ae14bc1572a2ce9263368cd5282dac3241eb8",
    "sig": "KU0XF341wZbxx7dExqYpGCcK3pkHlGqXmk1Td2p0z2VZ5w+tmKL590DL7AGyjNeO5jGghJz0dxJ12uAhzSJtuAX37hfpUIZzqYLFfeeXDiV49bni"
           "8Qfql7LtAYPKzeAT4udr4cU3Ic9aY8coO0qUS4H4PQKFeG+8B1x1Zo54rhFaDcOjzI8l0rpUnUP9It9VUXfAwbN9Fbiit4WF+KZenPOryjoSCAKGOkdF"
           "WKgsK8tAZI3rY2lK/RhTlpZEqSvoqYPhwg9ex6pDJuKU/EPX57livWo+thyAeB0aeMp3G8L2yAYHTNcT11KXs0SixrwmNGGyfgQgpn1oHePK/j89Og==",
}


def _offer(version="0.2.0", sha="a" * 64, sig="c2lnbmF0dXJl"):
    return {"version": version, "file": f"puca-decky-{version}.zip", "sha256": sha, "signature": sig}


# 0.5.0 in Arabic-Indic and in full-width digits, and a mix: digits to
# Python's \d and to int(), never to the frontend.
OTHER_DIGITS = ("\u0660.\u0665.\u0660", "\uff10.\uff15.\uff10", "0.\u0665")


class VersionTests(unittest.TestCase):
    def test_numbers_not_letters(self):
        self.assertTrue(pu.is_newer("0.2.0", "0.1.9"))
        self.assertTrue(pu.is_newer("0.10.0", "0.9.9"))
        self.assertTrue(pu.is_newer("1.0", "0.99.99"))
        self.assertFalse(pu.is_newer("0.2", "0.2.0"))
        self.assertFalse(pu.is_newer("0.2.0", "0.2"))
        self.assertTrue(pu.is_newer("0.2.1", "0.2"))
        self.assertFalse(pu.is_newer("0.1.9", "0.2.0"))
        self.assertFalse(pu.is_newer("0.2.0", "0.2.0"))

    def test_anything_else_is_never_newer(self):
        for bad in ("dev", "", "0.2.0-beta", "v0.2.0", "1.2.3.4.5", None, 3) + OTHER_DIGITS:
            self.assertFalse(pu.is_newer(bad, "0.1.0"), bad)
            self.assertFalse(pu.is_newer("9.9.9", bad), bad)

    def test_only_ascii_digits_make_a_version(self):
        # Python's \d is any Unicode digit, and int() reads them too; the
        # frontend's \d is ASCII only (src/update.ts), and so is this now.
        for bad in OTHER_DIGITS:
            self.assertIsNone(pu.parse_version(bad), ascii(bad))
        self.assertEqual(pu.parse_version("0.5.0"), (0, 5, 0))


class SiteTests(unittest.TestCase):
    def test_an_https_origin(self):
        self.assertEqual(pu.download_origin("https://download.example.com"), "https://download.example.com")
        self.assertEqual(pu.download_origin("https://download.example.com/"), "https://download.example.com")
        self.assertEqual(pu.download_origin("https://Download.Example.com:8443"), "https://download.example.com:8443")
        self.assertEqual(pu.download_origin("http://127.0.0.1:8080"), "http://127.0.0.1:8080")
        self.assertEqual(pu.manifest_url("https://d.example.com"), "https://d.example.com/steam-deck/puca-decky.json")
        self.assertEqual(pu.zip_url("https://d.example.com", _offer()), "https://d.example.com/steam-deck/puca-decky-0.2.0.zip")

    def test_refuses_rather_than_trims(self):
        for bad in ("http://download.example.com", "https://download.example.com/steam-deck", "https://u:p@d.example.com",
                    "https://d.example.com/?x=1", "https://d.example.com/#x", "ftp://d.example.com", "file:///etc",
                    "https://d.example.com:99999", "", None, 42, "https://" + "a" * 600):
            self.assertIsNone(pu.download_origin(bad), bad)


class ManifestTests(unittest.TestCase):
    def test_reads_a_well_formed_one(self):
        o = _offer()
        self.assertEqual(pu.read_manifest(json.dumps({**o, "extra": 1}).encode()), o)

    def test_refuses_the_rest(self):
        bad = [
            _offer(version="0.2.0-rc1"),
            {**_offer(), "file": "puca-decky-0.3.0.zip"},
            {**_offer(), "file": "../puca-decky-0.2.0.zip"},
            _offer(sha="A" * 64),
            _offer(sha="a" * 63),
            _offer(sig="not base64!"),
            _offer(sig="A" * 1025),
            {k: v for k, v in _offer().items() if k != "signature"},
        ]
        bad += [_offer(version=v) for v in OTHER_DIGITS]
        for o in bad:
            self.assertIsNone(pu.read_manifest(json.dumps(o).encode()), o)
        self.assertIsNone(pu.read_manifest(b"[1]"))
        self.assertIsNone(pu.read_manifest(b"\xff\xfe"))
        self.assertIsNone(pu.read_manifest(b" " * (pu.MAX_MANIFEST_BYTES + 1)))

    def test_the_release_check_refuses_other_digits_too(self):
        # verify_update.py reads the manifest through puca_update.
        with tempfile.TemporaryDirectory() as d:
            manifest = os.path.join(d, "puca-decky.json")
            with open(manifest, "w", encoding="utf-8") as f:
                json.dump(_offer(version=OTHER_DIGITS[0]), f)
            self.assertEqual(vu.check(os.path.join(d, "unread.zip"), manifest),
                             [f"{manifest} is not a well-formed update manifest"])


class FilesTests(unittest.TestCase):
    def test_the_key_this_build_carries(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(pu.read_key(d), "no update-key.json: no updates")
            with open(os.path.join(d, "update-key.json"), "w") as f:
                json.dump({"kty": "RSA", "n": VECTOR["n"], "e": "AQAB", "d": "never-here"}, f)
            self.assertEqual(pu.read_key(d), {"kty": "RSA", "n": VECTOR["n"], "e": "AQAB"})
            with open(os.path.join(d, "update-key.json"), "w") as f:
                json.dump({"kty": "EC", "x": "1"}, f)
            self.assertIsNone(pu.read_key(d))

    def test_a_download_is_kept_alone_and_cleared_at_start(self):
        with tempfile.TemporaryDirectory() as d:
            first = pu.save_update(d, _offer("0.2.0"), b"one")
            second = pu.save_update(d, _offer("0.2.1"), b"two")
            self.assertEqual(os.listdir(os.path.join(d, pu.UPDATES_DIR)), ["puca-decky-0.2.1.zip"])
            self.assertFalse(os.path.exists(first))
            with open(second, "rb") as f:
                self.assertEqual(f.read(), b"two")
            pu.clear_updates(d)
            self.assertEqual(os.listdir(os.path.join(d, pu.UPDATES_DIR)), [])
            pu.clear_updates(os.path.join(d, "nowhere"))  # nothing there: no error


class RsaTests(unittest.TestCase):
    def setUp(self):
        self.n = int.from_bytes(base64.urlsafe_b64decode(VECTOR["n"] + "=="), "big")
        self.e = 65537
        self.sig = base64.b64decode(VECTOR["sig"])
        self.msg = vu.update_message("0.2.0", VECTOR["sha"])

    def test_the_signature_node_made_verifies(self):
        self.assertEqual(VECTOR["sha"], hashlib.sha256(b"a release").hexdigest())
        self.assertTrue(vu.rsa_pkcs1_sha256_verify(self.n, self.e, self.msg, self.sig))

    def test_nothing_else_does(self):
        flipped = bytearray(self.sig)
        flipped[-1] ^= 1
        self.assertFalse(vu.rsa_pkcs1_sha256_verify(self.n, self.e, self.msg, bytes(flipped)))
        self.assertFalse(vu.rsa_pkcs1_sha256_verify(self.n, self.e, vu.update_message("0.2.1", VECTOR["sha"]), self.sig))
        self.assertFalse(vu.rsa_pkcs1_sha256_verify(self.n, self.e, self.msg[len("puca-decky-update/1\n"):], self.sig))
        self.assertFalse(vu.rsa_pkcs1_sha256_verify(self.n, self.e, self.msg, self.sig[1:]))
        self.assertFalse(vu.rsa_pkcs1_sha256_verify(self.n, self.e, self.msg, (self.n + 1).to_bytes(256, "big")))
        self.assertFalse(vu.rsa_pkcs1_sha256_verify(self.n, 3, self.msg, self.sig))

    def test_the_key_must_be_a_real_one(self):
        self.assertEqual(vu.read_jwk(json.dumps({"kty": "RSA", "n": VECTOR["n"], "e": "AQAB"}).encode()), (self.n, 65537))
        self.assertIsNone(vu.read_jwk(json.dumps({"kty": "RSA", "n": VECTOR["n"][:100], "e": "AQAB"}).encode()))
        self.assertIsNone(vu.read_jwk(json.dumps({"kty": "RSA", "n": VECTOR["n"], "e": "Ag"}).encode()))
        self.assertIsNone(vu.read_jwk(b"{}"))


SITE = "https://download.example.com"


def _decky_stub(runtime: str):
    d = types.ModuleType("decky")
    d.logged = []
    d.logger = types.SimpleNamespace(info=lambda msg, *args: d.logged.append(msg % args),
                                     warning=lambda *a, **k: None, exception=lambda *a, **k: None)

    async def emit(*_):
        pass

    d.emit = emit
    d.DECKY_PLUGIN_SETTINGS_DIR = d.DECKY_PLUGIN_DIR = HERE
    d.DECKY_PLUGIN_RUNTIME_DIR = runtime
    d.DECKY_PLUGIN_VERSION = "0.0.0"
    return d


class DownloadTests(unittest.TestCase):
    """What Update downloads (main.py, download_update): what the download
    site offers when it is pressed, if that is newer than the installed
    version. The panel's own offer can be days old: the owner's Deck slept
    through a release and kept offering 0.3.0, and Update, which insisted on
    exactly that version, said "the download site no longer offers that
    version" and installed nothing."""

    def setUp(self):
        self.runtime = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.runtime, ignore_errors=True)
        sys.modules["decky"] = self.decky = _decky_stub(self.runtime)
        sys.modules.pop("main", None)
        import main  # noqa: E402 (after the stand-in for Decky)
        self.main = main
        self.addCleanup(sys.modules.pop, "main", None)
        self.files: dict = {}
        self.fetched: list = []

        async def fetch(url, limit):
            self.fetched.append(url)
            data = self.files.get(url)
            if data is not None and len(data) > limit:
                raise main.FetchError("the download is too large")
            return data  # None: a 404

        main._fetch = fetch

    def publish(self, version, data=None, signature="c2lnbmF0dXJl"):
        """From now on the site offers `version`: a manifest, and the zip it names."""
        data = f"the bytes of puca-decky-{version}.zip".encode() if data is None else data
        offer = {"version": version, "file": f"puca-decky-{version}.zip",
                 "sha256": hashlib.sha256(data).hexdigest(), "signature": signature}
        self.files = {pu.manifest_url(SITE): json.dumps(offer).encode(), pu.zip_url(SITE, offer): data}
        return offer, data

    def download(self, installed, shown):
        """The panel's Update, on a plugin of version `installed` that offered `shown`."""
        self.decky.DECKY_PLUGIN_VERSION = installed
        self.fetched.clear()
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(self.main.Plugin().download_update(SITE, shown))
        finally:
            loop.close()

    def saved(self):
        folder = os.path.join(self.runtime, pu.UPDATES_DIR)
        return sorted(os.listdir(folder)) if os.path.isdir(folder) else []

    def test_a_stale_offer_downloads_what_the_site_offers_now(self):
        offer, data = self.publish("0.4.1")
        r = self.download(installed="0.2.0", shown="0.3.0")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["value"]["current"], "0.2.0")
        self.assertEqual(r["value"]["offer"], offer, "the offer it fetched, signature and all: what the frontend checks")
        with open(r["value"]["path"], "rb") as f:
            self.assertEqual(f.read(), data)
        self.assertEqual(self.saved(), ["puca-decky-0.4.1.zip"])
        self.assertEqual(self.fetched, [pu.manifest_url(SITE), pu.zip_url(SITE, offer)])
        self.assertTrue(any("0.3.0" in line and "0.4.1" in line for line in self.decky.logged), self.decky.logged)

    def test_the_offer_shown_is_downloaded_while_it_is_the_newest(self):
        offer, _ = self.publish("0.4.1")
        r = self.download(installed="0.2.0", shown="0.4.1")
        self.assertEqual(r["value"]["offer"], offer)
        self.assertEqual(self.saved(), ["puca-decky-0.4.1.zip"])

    def test_the_same_version_or_an_older_one_is_never_downloaded(self):
        for offered in ("0.4.1", "0.4", "0.4.0", "0.2.0"):
            with self.subTest(installed="0.4.1", offered=offered):
                offer, _ = self.publish(offered)
                # Even asked for by name: no panel can make it download one.
                r = self.download(installed="0.4.1", shown=offered)
                self.assertEqual(r, {"ok": True, "value": {"current": "0.4.1", "offer": offer, "path": None}})
                self.assertEqual(self.fetched, [pu.manifest_url(SITE)], "the zip is never fetched")
                self.assertEqual(self.saved(), [])

    def test_a_version_in_other_digits_is_refused_before_any_download(self):
        # The frontend could never accept it, so its zip (up to 32 MB) is not fetched.
        for version in OTHER_DIGITS:
            with self.subTest(version=ascii(version)):
                self.publish(version)
                r = self.download(installed="0.2.0", shown="0.3.0")
                self.assertFalse(r["ok"], r)
                self.assertEqual(self.fetched, [pu.manifest_url(SITE)], "the zip is never fetched")
                self.assertEqual(self.saved(), [])

    def test_a_site_that_offers_nothing_is_up_to_date_not_an_error(self):
        r = self.download(installed="0.2.0", shown="0.3.0")
        self.assertEqual(r, {"ok": True, "value": {"current": "0.2.0", "offer": None, "path": None}})
        self.assertEqual(self.saved(), [])

    def test_a_damaged_or_missing_zip_and_an_unreadable_manifest_are_still_refused(self):
        offer, data = self.publish("0.4.1")
        self.files[pu.zip_url(SITE, offer)] = data + b"!"
        r = self.download(installed="0.2.0", shown="0.3.0")
        self.assertFalse(r["ok"], r)
        self.assertIn("damaged", r["error"])
        del self.files[pu.zip_url(SITE, offer)]
        r = self.download(installed="0.2.0", shown="0.3.0")
        self.assertFalse(r["ok"], r)
        self.assertIn("does not have the file", r["error"])
        self.files[pu.manifest_url(SITE)] = b"{not json"
        r = self.download(installed="0.2.0", shown="0.3.0")
        self.assertFalse(r["ok"], r)
        self.assertEqual(self.saved(), [])

    def test_the_signature_handed_on_is_the_one_over_what_was_downloaded(self):
        """The backend never judges a signature; the frontend does, on the
        offer this hands it (src/update.ts). So that must be the offer whose
        zip was downloaded, as published: here one signed with the throwaway
        key of VECTOR."""
        self.publish("0.2.0", data=b"a release", signature=VECTOR["sig"])
        r = self.download(installed="0.1.0", shown="0.1.5")
        got = r["value"]["offer"]
        n = int.from_bytes(base64.urlsafe_b64decode(VECTOR["n"] + "=="), "big")
        message = vu.update_message(got["version"], got["sha256"])
        self.assertTrue(vu.rsa_pkcs1_sha256_verify(n, 65537, message, base64.b64decode(got["signature"])))
        with open(r["value"]["path"], "rb") as f:
            self.assertEqual(hashlib.sha256(f.read()).hexdigest(), got["sha256"])


def _node() -> str | None:
    return shutil.which("node")


@unittest.skipIf(_node() is None, "needs Node, which signs releases (scripts/signing.mjs)")
class ReleaseTests(unittest.TestCase):
    """A release made the way the release script makes one, checked the way
    dual-ship.sh checks it before publishing."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.keys = [self._keypair(f"k{i}") for i in range(2)]

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def _node(self, script: str, *args: str) -> str:
        signer = os.path.join(PLUGIN, "scripts", "signing.mjs").replace("\\", "/")
        code = f"import {{ pathToFileURL }} from 'node:url';\nconst m = await import(pathToFileURL({json.dumps(signer)}).href);\n{script}"
        r = subprocess.run(["node", "--input-type=module", "-e", code, *args], capture_output=True, text=True, check=True)
        return r.stdout

    def _keypair(self, name: str) -> tuple[str, str]:
        pem = os.path.join(self.dir, f"{name}.pem")
        jwk = os.path.join(self.dir, f"{name}.json")
        self._node(
            "import { generateKeyPairSync } from 'node:crypto'; import { writeFileSync } from 'node:fs';\n"
            "const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });\n"
            "const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });\n"
            "writeFileSync(process.argv[1], pem); writeFileSync(process.argv[2], JSON.stringify(m.publicJwk(pem)));",
            pem, jwk)
        return pem, jwk

    def _release(self, version: str, key: tuple[str, str], embed: tuple[str, str] | None = None) -> tuple[str, str]:
        """A zip as package.py lays it out, and its manifest signed with key."""
        folder = os.path.join(self.dir, version + "-" + os.path.basename(key[0]))
        os.makedirs(folder, exist_ok=True)
        zip_path = os.path.join(folder, f"puca-decky-{version}.zip")
        with zipfile.ZipFile(zip_path, "w") as z:
            z.writestr("puca/package.json", json.dumps({"name": "puca-decky", "version": version}))
            z.writestr("puca/main.py", "# the backend")
            if embed is not None:
                with open(embed[1], "rb") as f:
                    z.writestr("puca/update-key.json", f.read())
        manifest = os.path.join(folder, "puca-decky.json")
        self._node(
            "import { readFileSync, writeFileSync } from 'node:fs'; import { basename } from 'node:path';\n"
            "const [zip, version, pem, out] = process.argv.slice(1);\n"
            "writeFileSync(out, JSON.stringify(m.signRelease(readFileSync(zip), basename(zip), version, readFileSync(pem))));",
            zip_path, version, key[0], manifest)
        return zip_path, manifest

    def test_a_release_signed_with_the_key_it_carries_passes(self):
        k = self.keys[0]
        old = self._release("0.2.0", k, embed=k)
        new = self._release("0.2.1", k, embed=k)
        self.assertEqual(vu.check(*new), [])
        self.assertEqual(vu.check(*new, installed=old[0]), [])
        self.assertEqual(vu.main([new[0], new[1], "--installed", old[0]]), 0)

    def test_one_the_installed_plugins_would_refuse_is_not_published(self):
        k0, k1 = self.keys
        old = self._release("0.2.0", k0, embed=k0)
        # Signed with a new key and carrying it: fine on its own, but every
        # installed plugin holds k0 and would never accept it.
        new = self._release("0.2.1", k1, embed=k1)
        self.assertEqual(vu.check(*new), [])
        problems = vu.check(*new, installed=old[0])
        self.assertTrue(any("installed plugins would refuse it" in p for p in problems), problems)

    def test_older_or_the_same_version_is_not_published_over_a_newer_one(self):
        k = self.keys[0]
        published = self._release("0.3.0", k, embed=k)
        older = self._release("0.2.9", k, embed=k)
        self.assertTrue(any("not newer" in p for p in vu.check(*older, installed=published[0])))

    def test_a_build_without_the_key_or_with_another_is_refused(self):
        k0, k1 = self.keys
        keyless = self._release("0.2.0", k0, embed=None)
        self.assertTrue(any("no update-key.json" in p for p in vu.check(*keyless)))
        mismatched = self._release("0.2.0", k0, embed=k1)
        self.assertTrue(any("does not verify under the key inside the zip" in p for p in vu.check(*mismatched)))

    def _raw_rsa(self, key: tuple[str, str], block: bytes) -> bytes:
        """The private key applied to `block` with no padding at all: a value
        that opens to exactly that block, well formed or not."""
        out = self._node(
            "import { privateDecrypt, constants } from 'node:crypto'; import { readFileSync } from 'node:fs';\n"
            "const s = privateDecrypt({ key: readFileSync(process.argv[1]), padding: constants.RSA_NO_PADDING }, Buffer.from(process.argv[2], 'hex'));\n"
            "process.stdout.write(s.toString('hex'));",
            key[0], block.hex())
        return bytes.fromhex(out)

    def test_the_whole_signature_block_is_checked_not_just_its_hash(self):
        """A verifier that compares only the digest at the end, or parses the
        block leniently, accepts blocks a forger can make far more easily
        (the classic PKCS#1 v1.5 mistakes)."""
        k = self.keys[0]
        with open(k[1], "rb") as f:
            n, e = vu.read_jwk(f.read())
        size = (n.bit_length() + 7) // 8
        message = vu.update_message("0.2.0", "ab" * 32)
        digest = hashlib.sha256(message).digest()
        t = vu.DIGEST_INFO_SHA256 + digest
        good = b"\x00\x01" + b"\xff" * (size - len(t) - 3) + b"\x00" + t
        # POSITIVE CONTROL: the construction makes a signature the check accepts.
        self.assertTrue(vu.rsa_pkcs1_sha256_verify(n, e, message, self._raw_rsa(k, good)))
        wrong_blocks = {
            "block type 2": b"\x00\x02" + good[2:],
            "no DigestInfo": b"\x00\x01" + b"\xff" * (size - 32 - 3) + b"\x00" + digest,
            "padding not all ff": b"\x00\x01" + b"\x5a" * (size - len(t) - 3) + b"\x00" + t,
            "SHA-1's DigestInfo": b"\x00\x01" + b"\xff" * (size - len(t) - 3) + b"\x00"
                                  + bytes.fromhex("3021300906052b0e03021a05000414") + b"\x00" * 4 + digest,
        }
        for what, block in wrong_blocks.items():
            self.assertEqual(len(block), size, what)
            with self.subTest(what):
                self.assertFalse(vu.rsa_pkcs1_sha256_verify(n, e, message, self._raw_rsa(k, block)))

    def test_a_manifest_that_does_not_match_its_zip_is_refused(self):
        k = self.keys[0]
        zip_path, manifest = self._release("0.2.0", k, embed=k)
        with open(manifest) as f:
            m = json.load(f)
        m["sha256"] = "0" * 64
        with open(manifest, "w") as f:
            json.dump(m, f)
        problems = vu.check(zip_path, manifest)
        self.assertTrue(any("SHA-256" in p for p in problems), problems)
        self.assertTrue(any("does not verify" in p for p in problems), problems)
        self.assertEqual(vu.main([zip_path, manifest]), 1)


if __name__ == "__main__":
    unittest.main()
