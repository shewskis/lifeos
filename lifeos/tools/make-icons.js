// Generates PNG icons (192, 512, maskable 512) without any dependencies: rasterises the ring logo and writes PNGs via zlib.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width * 4 + 1)] = 0; rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function lerp(a, b, t) { return a + (b - a) * t; }
function mix(c1, c2, t) { return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)]; }

function render(size, { maskable = false } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const S = size / 512; // scale from 512 design
  const cx = 256, cy = 256;
  const radius = maskable ? 0 : 112; // rounded corner radius in design units
  const bg1 = [26, 34, 64], bg2 = [11, 13, 18], ac1 = [110, 168, 255], ac2 = [155, 140, 255], green = [61, 220, 151];
  const ss = 3; // supersampling
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const x = (px + (sx + 0.5) / ss) / S, y = (py + (sy + 0.5) / ss) / S; // design coords
      // rounded rect mask
      let inside = true;
      if (!maskable) {
        const qx = Math.max(Math.abs(x - 256) - (256 - radius), 0), qy = Math.max(Math.abs(y - 256) - (256 - radius), 0);
        inside = Math.hypot(qx, qy) <= radius;
      }
      if (!inside) continue;
      const t = (x + y) / 1024;
      let col = mix(bg1, bg2, t);
      const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
      let ang = Math.atan2(dy, dx) + Math.PI / 2; if (ang < 0) ang += Math.PI * 2; // 0 at top, clockwise
      const frac = ang / (Math.PI * 2);
      // outer ring: r=150, width 26, 74% arc
      if (Math.abs(d - 150) <= 13 && frac <= 0.743) col = mix(ac1, ac2, t);
      // inner ring: r=92, width 22, 72.7% arc
      if (Math.abs(d - 92) <= 11 && frac <= 0.727) col = green;
      // round caps
      for (const [rr, w, f, c] of [[150, 13, 0.743, mix(ac1, ac2, t)], [92, 11, 0.727, green]]) {
        for (const ff of [0, f]) { const a2 = ff * Math.PI * 2 - Math.PI / 2; const ex = cx + rr * Math.cos(a2), ey = cy + rr * Math.sin(a2); if (Math.hypot(x - ex, y - ey) <= w) col = c; }
      }
      if (d <= 34) col = mix(ac1, ac2, t);
      r += col[0]; g += col[1]; b += col[2]; a += 255;
    }
    const n = ss * ss, i = (py * size + px) * 4;
    buf[i] = Math.round(r / n); buf[i + 1] = Math.round(g / n); buf[i + 2] = Math.round(b / n); buf[i + 3] = Math.round(a / n);
  }
  return png(size, size, buf);
}

const out = path.join(__dirname, '..', 'icons');
fs.writeFileSync(path.join(out, 'icon-192.png'), render(192));
fs.writeFileSync(path.join(out, 'icon-512.png'), render(512));
fs.writeFileSync(path.join(out, 'icon-maskable-512.png'), render(512, { maskable: true }));
console.log('icons written');
