/**
 * Package and sign a Púca for Steam Deck release for the plugin's own
 * updater (src/update.ts).
 *
 *     npm run release -- --key <release key, PEM>
 *
 * (npm run release builds first.) Then:
 *
 * 1. Writes out/update-key.json, the key's public half, which the zip carries
 *    so that this release can check the next one.
 * 2. Packages the zip with it (scripts/package.py --update-key).
 * 3. Signs it (scripts/signing.mjs) and writes out/puca-decky.json:
 *    {"version", "file", "sha256", "signature"}.
 * 4. Checks the result with a second implementation
 *    (scripts/verify_update.py) before saying it is done.
 *
 * Then: deploy/ops/dual-ship.sh decky out/puca-decky-<version>.zip out/puca-decky.json
 *
 * The key. Any RSA key of 2048 bits or more works; every release must be
 * signed with the SAME one, because installed plugins accept only the key
 * they were installed with. Púca's own releases use the mobile OTA key
 * (mobile-updater-rsa.key, already backed up by deploy/ops/backup-keys.sh).
 * Sharing it is safe because the two signatures cannot stand in for each
 * other: the OTA's checksum is a bare SHA-256 under the key, this one a
 * PKCS#1 DigestInfo over a text that begins with "puca-decky-update/1".
 * Neither verifies as the other (tests/update.test.ts checks both ways).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicJwk, signRelease } from './signing.mjs';

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(PLUGIN, 'out');
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

function run(cmd, args) {
    const r = spawnSync(cmd, args, { cwd: PLUGIN, stdio: 'inherit' });
    if (r.status !== 0) {
        console.error(`${cmd} ${args.join(' ')} failed`);
        process.exit(1);
    }
}

const i = process.argv.indexOf('--key');
if (i < 0 || !process.argv[i + 1]) {
    console.error('usage: npm run release -- --key <release key, PEM>');
    process.exit(2);
}
const pem = readFileSync(process.argv[i + 1]);
mkdirSync(OUT, { recursive: true });
const keyFile = join(OUT, 'update-key.json');
writeFileSync(keyFile, JSON.stringify(publicJwk(pem)) + '\n');

run(PYTHON, [join('scripts', 'package.py'), '--update-key', keyFile]);

const { version } = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'));
const zipName = `puca-decky-${version}.zip`;
const zip = join(OUT, zipName);
const manifestFile = join(OUT, 'puca-decky.json');
writeFileSync(manifestFile, JSON.stringify(signRelease(readFileSync(zip), zipName, version, pem), null, 2) + '\n');

run(PYTHON, [join('scripts', 'verify_update.py'), zip, manifestFile]);
console.log(`\n${basename(zip)} and puca-decky.json are ready in out/.`);
console.log(`Publish them with: deploy/ops/dual-ship.sh decky ${zip} ${manifestFile}`);
