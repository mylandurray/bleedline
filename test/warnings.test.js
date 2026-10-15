// Small fixes and wording (phase 5): marks vs bleed, TrimBox wording, PNG/JPEG warnings, huge pages.
const test = require('node:test');
const assert = require('node:assert/strict');
const PDFLib = require('pdf-lib');
const { addBleed } = require('../src/bleed.js');
const fx = require('./fixtures.js');
const { pageStreams } = require('./invariants.js');

const MM = fx.MM;
const base = {
  bleedMm: 3, mode: 'mirror', sliverMm: 0.5, marks: true, markOffsetMm: 3, markLenMm: 5,
  markWeightPt: 0.25,
};
const run = (bytes, kind, o = {}) => addBleed(PDFLib, bytes, kind, { ...base, ...o });
const has = (r, re) => r.warnings.some((w) => re.test(w));
const dump = (r) => r.warnings.join('|');

test('marks may sit inside the bleed, at the offset asked', async () => {
  const src = await fx.page({ media: [100 * MM, 100 * MM], content: fx.fill(fx.mmRect(0, 0, 100, 100)) });
  const r = await run(src, 'pdf', { bleedMm: 5, markOffsetMm: 2, markLenMm: 4 });
  assert.ok(!has(r, /moved/), dump(r));
  // Page = trim + 2 * (max(bleed, offset + length) + 2 mm).
  const margin = 8 * MM;
  const doc = await PDFLib.PDFDocument.load(r.bytes);
  const { width } = doc.getPage(0).getSize();
  assert.ok(Math.abs(width - (100 * MM + 2 * margin)) < 0.01, `width ${width}`);
  // A mark starts 2 mm below the trim corner, inside the 5 mm bleed.
  const node = doc.getPage(0).node;
  const text = pageStreams(doc, node).join('\n');
  const starts = [...text.matchAll(/(-?[\d.]+) (-?[\d.]+) m\b/g)].map((m) => [+m[1], +m[2]]);
  assert.ok(starts.some(([x, y]) => Math.abs(x - margin) < 0.01 && Math.abs(y - (margin - 2 * MM)) < 0.01), JSON.stringify(starts));
});

test('TrimBox equal to the page is worded as "same as the page", a missing one as "no TrimBox"', async () => {
  const same = await fx.page({ media: [100 * MM, 100 * MM], trim: fx.mmRect(0, 0, 100, 100), content: fx.fill(fx.mmRect(0, 0, 100, 100)) });
  const r = await run(same, 'pdf');
  assert.ok(has(r, /TrimBox is the same as the page \(no trim set\)/), dump(r));
  assert.ok(!has(r, /no TrimBox/), dump(r));
  const none = await fx.page({ media: [100 * MM, 100 * MM], content: fx.fill(fx.mmRect(0, 0, 100, 100)) });
  const r2 = await run(none, 'pdf');
  assert.ok(has(r2, /no TrimBox or crop marks/), dump(r2));
  assert.ok(!has(r2, /same as the page/), dump(r2));
});

test('PNG warnings name only the real reason', async () => {
  const alpha = await run(fx.png({ width: 1, height: 1, alpha: true, grey: true }), 'png');
  assert.ok(has(alpha, /Greyscale PNG \(with transparency\) was converted to RGB/), dump(alpha));
  assert.ok(!has(alpha, /nterlaced/), dump(alpha));
  const inter = await run(fx.png({ width: 1, height: 1, interlace: true }), 'png');
  assert.ok(has(inter, /Interlaced PNG was decoded/), dump(inter));
  assert.ok(!has(inter, /transparency/), dump(inter));
  const interGrey = await run(fx.png({ width: 1, height: 1, interlace: true, grey: true }), 'png');
  assert.ok(has(interGrey, /Greyscale PNG \(interlaced\) was converted/), dump(interGrey));
  assert.ok(!has(interGrey, /transparency/), dump(interGrey));
});

test('grey PNG with a profile that has to be converted says the profile was dropped', async () => {
  const r = await run(fx.png({ width: 1, height: 1, alpha: true, grey: true, iccp: true }), 'png');
  assert.ok(has(r, /converted to RGB \(will print 4-colour\); its greyscale colour profile was dropped/), dump(r));
  const none = await run(fx.png({ width: 1, height: 1, alpha: true, grey: true }), 'png');
  assert.ok(!has(none, /profile was dropped/), dump(none));
});

test('arithmetic-coded and 12-bit JPEGs are refused', async () => {
  for (const sof of [0xc9, 0xca, 0xcb, 0xcd, 0xcf]) {
    await assert.rejects(run(fx.jpg({ sof }), 'jpg'), /Arithmetic-coded or 12-bit JPEG/, `SOF 0x${sof.toString(16)}`);
  }
  await assert.rejects(run(fx.jpg({ sof: 0xc1, bpc: 12 }), 'jpg'), /12-bit JPEG/);
  const ok = await run(fx.jpg({ sof: 0xc2 }), 'jpg'); // progressive is fine
  assert.ok(ok.bytes.length > 0);
});

test('a page over 14,400 pt warns', async () => {
  const big = await fx.page({ media: [15000, 200] });
  const r = await run(big, 'pdf');
  assert.ok(has(r, /larger than the 5\.08 m PDF limit/), dump(r));
  const small = await run(await fx.page({ media: [500, 200] }), 'pdf');
  assert.ok(!has(small, /5\.08 m/), dump(small));
});
