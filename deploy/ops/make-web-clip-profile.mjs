/**
 * The iPhone/iPad "Install with one tap" configuration profile, made here.
 *
 *   node deploy/ops/make-web-clip-profile.mjs https://app.example.org frontend/public/apple-touch-icon.png [label]
 *
 * prints the profile (a property list, `.mobileconfig`) on stdout.
 *
 * WHAT IT IS. A Web Clip: one payload that puts an icon on the Home Screen which
 * opens the web app's address as a full-screen web app (Apple's WebClip payload,
 * `com.apple.webClip.managed`). It is the one-tap alternative to Safari's Share >
 * Add to Home Screen steps, offered BESIDE them on the download page
 * (deploy/download-site/index.html, `#iphone`).
 *
 * WHAT IT CONTAINS, and the page says exactly this to the person installing it:
 * the address, the label, the icon, FullScreen and IsRemovable. NO certificate, no
 * restriction, no VPN, no second payload, no managed settings of any kind.
 * `IgnoreManifestScope` is left out on purpose (the default keeps a link to
 * another site opening in Safari's own UI rather than inside Púca's window).
 *
 * RENDERED PER DEPLOYMENT, at ship time. dual-ship.sh runs this with the
 * operator's web app host from hosts.conf and refuses to ship if it cannot: the
 * address is not in any tracked file. The identifiers are derived from that host,
 * so a deployment always produces the same profile (installing it again REPLACES
 * the clip rather than adding a second) and two deployments never collide.
 *
 * UNSIGNED. Signing needs a certificate iOS trusts for profiles; the operator's
 * TLS certificate is a serverAuth certificate that Caddy renews every couple of
 * months, so a signature on it would expire and have to be redone at each renewal.
 * iOS shows an unsigned profile as "Not Verified", which the page explains.
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAX_ICON_BYTES = 1024 * 1024; // Apple: under 1 MB
export const ICON_SIZE = 180;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Dimensions of a PNG from its IHDR; throws on anything that is not one. */
export function pngSize(png) {
    if (png.length < 33 || !png.subarray(0, 8).equals(PNG_MAGIC) || png.toString('latin1', 12, 16) !== 'IHDR') {
        throw new Error('the icon is not a PNG');
    }
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function xmlEscape(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** A stable, RFC 4122 shaped (version 5 layout) UUID from a name. */
export function uuidFor(name) {
    const h = createHash('sha256').update(name).digest();
    h[6] = (h[6] & 0x0f) | 0x50;
    h[8] = (h[8] & 0x3f) | 0x80;
    const x = h.subarray(0, 16).toString('hex');
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`.toUpperCase();
}

/**
 * @param {{ url: string, iconPng: Buffer, label?: string }} o
 * @returns {string} the profile
 */
export function webClipProfile({ url, iconPng, label = 'Púca' }) {
    let u;
    try {
        u = new URL(url);
    } catch {
        throw new Error(`not an address: ${url}`);
    }
    if (u.protocol !== 'https:') throw new Error(`the web app address must be https: ${url}`);
    if (/[\s\u0000-\u001f]/.test(url)) throw new Error('the address has whitespace or control characters');
    if (u.hostname === '' || /example\.(com|org|net)$/i.test(u.hostname)) {
        throw new Error(`refusing a placeholder host: ${u.hostname}`);
    }
    if (label.trim() === '') throw new Error('the label is empty');
    const { width, height } = pngSize(iconPng);
    if (width !== ICON_SIZE || height !== ICON_SIZE) {
        throw new Error(`the icon must be ${ICON_SIZE}x${ICON_SIZE}, it is ${width}x${height}`);
    }
    if (iconPng.length >= MAX_ICON_BYTES) throw new Error('the icon is over 1 MB');

    const slug = u.host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const id = `app.puca.webclip.${slug}`;
    const b64 = iconPng.toString('base64').match(/.{1,68}/g).join('\n\t\t\t');
    const text = (s) => xmlEscape(s);
    // The address as the profile carries it: the origin and path, nothing added.
    const target = u.href;

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>PayloadContent</key>
	<array>
		<dict>
			<key>FullScreen</key>
			<true/>
			<key>Icon</key>
			<data>
			${b64}
			</data>
			<key>IsRemovable</key>
			<true/>
			<key>Label</key>
			<string>${text(label)}</string>
			<key>PayloadDescription</key>
			<string>A Home Screen icon that opens ${text(u.host)} as a full-screen web app.</string>
			<key>PayloadDisplayName</key>
			<string>${text(label)}</string>
			<key>PayloadIdentifier</key>
			<string>${id}.clip</string>
			<key>PayloadType</key>
			<string>com.apple.webClip.managed</string>
			<key>PayloadUUID</key>
			<string>${uuidFor('puca-web-clip-payload:' + u.host)}</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
			<key>URL</key>
			<string>${text(target)}</string>
		</dict>
	</array>
	<key>PayloadDescription</key>
	<string>Adds ${text(label)} to your Home Screen. This profile contains only that icon: no certificates, restrictions or other settings.</string>
	<key>PayloadDisplayName</key>
	<string>${text(label)}</string>
	<key>PayloadIdentifier</key>
	<string>${id}</string>
	<key>PayloadRemovalDisallowed</key>
	<false/>
	<key>PayloadType</key>
	<string>Configuration</string>
	<key>PayloadUUID</key>
	<string>${uuidFor('puca-web-clip-profile:' + u.host)}</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
</dict>
</plist>
`;
}

// CLI. realpath on both sides: a plain `argv[1] === import.meta.url` comparison
// is false for a symlinked or 8.3-named path and the script would silently print
// nothing (the same trap make-qr-svg.mjs documents).
const isMain = (() => {
    try {
        return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
})();
if (isMain) {
    const [url, iconPath, label] = process.argv.slice(2);
    if (!url || !iconPath) {
        console.error('usage: make-web-clip-profile.mjs <https://app-address> <180x180-icon.png> [label]');
        process.exit(2);
    }
    try {
        process.stdout.write(webClipProfile({ url, iconPng: readFileSync(iconPath), label }));
    } catch (e) {
        console.error(`make-web-clip-profile: ${e.message}`);
        process.exit(1);
    }
}
