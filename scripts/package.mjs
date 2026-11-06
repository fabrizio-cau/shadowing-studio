// Builds the extension and zips the contents of dist/ for the Chrome Web Store:
//   npm run package   →   release/shadowing-studio-<version>.zip
// manifest.json sits at the root of the zip, as the store requires.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

execFileSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });

const DIST = path.resolve('dist');
const manifest = JSON.parse(readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));

// Guard against shipping something the store would reject or that leaks test-only behaviour.
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) throw new Error(`Invalid manifest version "${manifest.version}".`);
const files = walk(DIST).sort();
const sourceMaps = files.filter((f) => f.endsWith('.map'));
if (sourceMaps.length) throw new Error(`Source maps found in dist/: ${sourceMaps.join(', ')}. Run a production build.`);

const out = path.resolve('release', `shadowing-studio-${manifest.version}.zip`);
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, zip(files.map((f) => ({ name: path.relative(DIST, f).split(path.sep).join('/'), data: readFileSync(f) }))));
console.log(`\nPackaged ${files.length} files (v${manifest.version}) → ${path.relative(process.cwd(), out)} (${(statSync(out).size / 1024).toFixed(0)} KB)`);

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

// ---- minimal ZIP writer (deflate, no zip64; fine for an extension of a few hundred KB) ----

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  // Fixed timestamp (1980-01-01) so the same build produces the same zip.
  const time = 0, date = (0 << 9) | (1 << 5) | 1;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, compressed);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBuf.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, end]);
}
