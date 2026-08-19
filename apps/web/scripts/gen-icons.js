// Regenerates the favicon set from public/favicon.svg:
//   favicon.ico (16/32/48, 32bpp BMP entries), apple-touch-icon.png (180),
//   icon-192.png, icon-512.png. manifest.webmanifest and app/layout.tsx
//   reference these by name - keep the names.
//
// Needs sharp, which only exists inside the web container:
//   docker compose exec -T -u 1000:1000 web node - < apps/web/scripts/gen-icons.js
// Then restart web (`next start` lists public/ once at startup).
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const PUB = "/app/apps/web/public";
const svg = fs.readFileSync(path.join(PUB, "favicon.svg"));
const VB = 32; // viewBox of favicon.svg

// Rasterize the SVG at the exact target size (density scales the 32-unit
// viewBox up; resize pins the result to size x size).
const render = (size) =>
  sharp(svg, { density: Math.ceil((72 * size) / VB) }).resize(size, size, { fit: "contain", background: "#000" });

async function png(size, name) {
  await render(size).png({ compressionLevel: 9 }).toFile(path.join(PUB, name));
  console.log("wrote", name, size + "x" + size);
}

// --- ICO with 32bpp BMP (DIB) entries + AND mask ---------------------------
// Layout: ICONDIR(6) + n*ICONDIRENTRY(16) + n*(BITMAPINFOHEADER(40) + XOR + AND)
function dibEntry(rgba, s) {
  const rowBytes = s * 4;
  const andRow = Math.ceil(s / 32) * 4; // 1bpp rows padded to 4 bytes
  const xor = Buffer.alloc(rowBytes * s);
  // BMP rows are bottom-up and BGRA
  for (let y = 0; y < s; y++) {
    const src = (s - 1 - y) * rowBytes;
    const dst = y * rowBytes;
    for (let x = 0; x < s; x++) {
      const i = src + x * 4, o = dst + x * 4;
      xor[o] = rgba[i + 2]; xor[o + 1] = rgba[i + 1]; xor[o + 2] = rgba[i]; xor[o + 3] = rgba[i + 3];
    }
  }
  const and = Buffer.alloc(andRow * s); // opaque icon -> all-zero mask
  const hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40, 0);
  hdr.writeInt32LE(s, 4);
  hdr.writeInt32LE(s * 2, 8); // XOR + AND
  hdr.writeUInt16LE(1, 12);
  hdr.writeUInt16LE(32, 14);
  hdr.writeUInt32LE(0, 16);
  hdr.writeUInt32LE(xor.length + and.length, 20);
  return Buffer.concat([hdr, xor, and]);
}

async function ico(sizes, name) {
  const images = [];
  for (const s of sizes) {
    const rgba = await render(s).ensureAlpha().raw().toBuffer();
    images.push({ s, data: dibEntry(rgba, s) });
  }
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { s, data } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(s >= 256 ? 0 : s, 0);
    e.writeUInt8(s >= 256 ? 0 : s, 1);
    e.writeUInt8(0, 2); e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  const out = Buffer.concat([dir, ...entries, ...images.map((i) => i.data)]);
  fs.writeFileSync(path.join(PUB, name), out);
  console.log("wrote", name, sizes.join("/"), out.length + "B");
}

(async () => {
  await png(180, "apple-touch-icon.png");
  await png(192, "icon-192.png");
  await png(512, "icon-512.png");
  await ico([16, 32, 48], "favicon.ico");
})().catch((e) => { console.error(e); process.exit(1); });
