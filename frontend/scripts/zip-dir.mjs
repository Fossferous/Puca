/**
 * Zip a directory's CONTENTS (not the directory itself) into a Buffer —
 * deflated entries, forward-slash names, sorted, no directory entries.
 *
 * Exists so the Púca Notes OTA bundle can be produced by the build script
 * itself (scripts/build-notes-app.mjs --ota) instead of a hand-typed `zip -r`,
 * which Git Bash does not even have, and which is the step most likely to zip
 * the wrong thing (the directory instead of its contents, or dist/notes/
 * instead of dist-notes-app/). The Capgo updater unzips with
 * java.util.zip.ZipInputStream and creates parent directories itself
 * (CapgoUpdater.java), so no directory entries are needed. Needs Node 22+
 * (zlib.crc32).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

function listFiles(root, rel = '') {
    const out = [];
    for (const name of readdirSync(join(root, rel)).sort()) {
        const r = rel ? `${rel}/${name}` : name;
        if (statSync(join(root, r)).isDirectory()) out.push(...listFiles(root, r));
        else out.push(r);
    }
    return out;
}

export function zipDirectory(root) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    const files = listFiles(root);
    if (files.length === 0) throw new Error(`${root} is empty`);
    if (files.length > 0xfffe) throw new Error('too many files for a non-zip64 archive');
    for (const rel of files) {
        const raw = readFileSync(join(root, rel));
        const data = deflateRawSync(raw, { level: 9 });
        const name = Buffer.from(rel, 'utf8');
        const crc = crc32(raw);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);          // version needed
        local.writeUInt16LE(0x0800, 6);      // UTF-8 names
        local.writeUInt16LE(8, 8);           // deflate
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(name.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);        // version made by
        central.writeUInt16LE(20, 6);        // version needed
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        locals.push(local, name, data);
        centrals.push(central, name);
        offset += 30 + name.length + data.length;
    }
    if (offset > 0xfffffffe) throw new Error('bundle too large for a non-zip64 archive');
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
}
