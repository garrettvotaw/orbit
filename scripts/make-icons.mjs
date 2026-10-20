import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

/** Encode an RGBA pixel buffer as a PNG. */
function png({ size, rgba }) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Encode an RGBA pixel buffer as a 32-bit DIB icon frame: a BITMAPINFOHEADER
 * whose height covers both the bottom-up BGRA XOR bitmap and the 1-bit AND mask.
 */
function dib({ size, rgba }) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const xor = Buffer.alloc(size * size * 4);
  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size);
  for (let y = 0; y < size; y++) {
    const row = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dst = (row * size + x) * 4;
      xor[dst] = rgba[src + 2];
      xor[dst + 1] = rgba[src + 1];
      xor[dst + 2] = rgba[src];
      xor[dst + 3] = rgba[src + 3];
      if (rgba[src + 3] === 0) mask[row * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  header.writeUInt32LE(xor.length + mask.length, 20);
  return Buffer.concat([header, xor, mask]);
}

/**
 * The moon's tones: pale violet at rest, amber while something needs you. The small sizes rest a
 * shade deeper, or the moon washes out on a light taskbar.
 */
const MOON = { rest: ['#e2d9ff', '#b19bff'], restSmall: ['#cbbcff', '#9479ff'], alert: ['#ffd27a', '#f59e0b'] };
const SIZES = [16, 20, 24, 32, 40, 48, 64, 256];
/** At this size and below the shadow is dropped and the arc thickened, so the shape stays crisp. */
const SMALL = 24;

/**
 * The Orbit mark, the open orbit: a thick violet arc that stops short at the upper right, with the
 * moon sitting in the gap. `alert` turns the moon amber so the tray can breathe when something needs you.
 */
function orbitSvg({ alert = false, small = false } = {}) {
  const [moonTop, moonBottom] = alert ? MOON.alert : small ? MOON.restSmall : MOON.rest;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="arc" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#4a1fd0"/><stop offset=".6" stop-color="#7c5cff"/><stop offset="1" stop-color="#a78bfa"/>
    </linearGradient>
    <linearGradient id="moon" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${moonTop}"/><stop offset="1" stop-color="${moonBottom}"/>
    </linearGradient>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#2a0f80" flood-opacity=".35"/>
    </filter>
  </defs>
  <path d="M 207.2 114.8 A 82 82 0 1 1 149.2 56.8" fill="none" stroke="url(#arc)" stroke-width="${small ? 48 : 42}" stroke-linecap="round"/>
  <circle cx="196" cy="68" r="28" fill="url(#moon)"${small ? '' : ' filter="url(#shadow)"'}/>
</svg>
`;
}

/** Rasterize an SVG at one size in the browser and read its pixels back as straight RGBA. */
async function render(page, svg, size) {
  const data = await page.evaluate(
    async ({ svg, size }) => {
      const img = new Image();
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, size, size);
      return Array.from(ctx.getImageData(0, 0, size, size).data);
    },
    { svg, size },
  );
  return { size, rgba: Buffer.from(data) };
}

const frames = (page, alert) =>
  SIZES.reduce(
    async (done, size) => [...(await done), await render(page, orbitSvg({ alert, small: size <= SMALL }), size)],
    Promise.resolve([]),
  );

/**
 * Pack frames into a single .ico. Frames up to 64px are stored as plain DIB bitmaps
 * because the Windows shell only decodes PNG-compressed frames reliably at 256px;
 * smaller PNG frames come out blank on the taskbar.
 */
function ico(frames) {
  const images = frames.map((f) => ({
    size: f.size,
    data: f.size >= 256 ? png(f) : dib(f),
  }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0;
    e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

// Edge ships with Windows, so the dev machine already has a browser to draw with.
const browser = await chromium.launch({ channel: 'msedge' });
try {
  const page = await browser.newPage();
  mkdirSync('assets', { recursive: true });
  writeFileSync('assets/orbit.svg', orbitSvg());
  writeFileSync('assets/orbit-alert.svg', orbitSvg({ alert: true }));
  writeFileSync('assets/orbit.png', png(await render(page, orbitSvg(), 256)));
  writeFileSync('assets/orbit.ico', ico(await frames(page, false)));
  writeFileSync('assets/orbit-alert.ico', ico(await frames(page, true)));
} finally {
  await browser.close();
}
console.log('wrote assets/orbit.svg assets/orbit-alert.svg assets/orbit.png assets/orbit.ico assets/orbit-alert.ico');
