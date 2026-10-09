const test = require('node:test');
const PDFLib = require('pdf-lib');
const { addBleed } = require('../src/bleed.js');
const fx = require('./fixtures.js');
const { checkOutput } = require('./invariants.js');

const MM = fx.MM;
const base = {
  bleedMm: 3, mode: 'mirror', sliverMm: 0.5, marks: true, markOffsetMm: 3, markLenMm: 5,
  markWeightPt: 0.25, imageDpi: 300, useFileDpi: true, hideSeams: true,
};
const run = (bytes, kind, o = {}) => addBleed(PDFLib, bytes, kind, { ...base, ...o });

test('PDF with a TrimBox', async () => {
  const trim = fx.mmRect(10, 10, 90, 60);
  const src = await fx.page({
    media: [120 * MM, 90 * MM], trim,
    content: [fx.fill(trim, [0, 0.5, 1, 0]), fx.dieline(trim)].join('\n'),
  });
  const r = await run(src, 'pdf');
  await checkOutput(r.bytes, { trimMm: [90, 60], bleedMm: 3, marks: true, source: src, rawContent: true, pages: 1 });
});

test('PDF with a TrimBox, seams off: centre clip is the TrimBox', async () => {
  const trim = fx.mmRect(10, 10, 90, 60);
  const src = await fx.page({ media: [120 * MM, 90 * MM], trim, content: fx.fill(trim, [1, 0, 0, 0]) });
  const r = await run(src, 'pdf', { marks: false, hideSeams: false });
  await checkOutput(r.bytes, { trimMm: [90, 60], bleedMm: 3, source: src, exactCentreClip: true });
});

test('PDF without a TrimBox uses the page size', async () => {
  const src = await fx.page({ media: [100 * MM, 70 * MM], content: fx.fill(fx.mmRect(0, 0, 100, 70), [0, 0, 0, 0.8]) });
  const r = await run(src, 'pdf', { marks: false });
  await checkOutput(r.bytes, { trimMm: [100, 70], bleedMm: 3, source: src });
});

test('multi-page PDF keeps each page size', async () => {
  const src = await fx.pdf([
    { media: [100 * MM, 70 * MM], content: fx.fill(fx.mmRect(0, 0, 100, 70), [1, 0, 0, 0]) },
    { media: [50 * MM, 50 * MM], content: fx.fill(fx.mmRect(0, 0, 50, 50), [0, 1, 0, 0]) },
  ]);
  const r = await run(src, 'pdf');
  await checkOutput(r.bytes, { trimMm: [[100, 70], [50, 50]], bleedMm: 3, marks: true, source: src, pages: 2 });
});

test('JPG', async () => {
  // 600 x 300 px at 300 dpi = 50.8 x 25.4 mm
  const r = await run(fx.jpg({ width: 600, height: 300, dpi: 300 }), 'jpg');
  await checkOutput(r.bytes, { trimMm: [50.8, 25.4], bleedMm: 3, marks: true, pages: 1 });
});

test('PNG (opaque RGB)', async () => {
  const r = await run(fx.png({ width: 300, height: 150 }), 'png', { useFileDpi: false, imageDpi: 150 });
  await checkOutput(r.bytes, { trimMm: [50.8, 25.4], bleedMm: 3, marks: true, pages: 1 });
});

test('PNG with alpha (decode path)', async () => {
  const r = await run(fx.png({ width: 300, height: 150, alpha: true }), 'png', { useFileDpi: false, imageDpi: 150, marks: false });
  await checkOutput(r.bytes, { trimMm: [50.8, 25.4], bleedMm: 3, pages: 1 });
});

// ---------- option validation (phase 1a) ----------

const assert = require('node:assert/strict');
const simple = () => fx.page({ media: [100 * MM, 70 * MM], content: fx.fill(fx.mmRect(0, 0, 100, 70), [0, 0, 0, 0.8]) });

test('negative bleed throws', async () => {
  await assert.rejects(run(await simple(), 'pdf', { bleedMm: -3 }), /Bleed must be/);
});

test('NaN bleed throws', async () => {
  await assert.rejects(run(await simple(), 'pdf', { bleedMm: NaN }), /Bleed must be/);
});

test('bleed over 50 mm throws', async () => {
  await assert.rejects(run(await simple(), 'pdf', { bleedMm: 51 }), /Bleed must be/);
});

test('0 bleed works and warns', async () => {
  const src = await simple();
  const r = await run(src, 'pdf', { bleedMm: 0, marks: false });
  assert.ok(r.warnings.some((w) => /No bleed added/.test(w)), r.warnings.join('|'));
  await checkOutput(r.bytes, { trimMm: [100, 70], bleedMm: 0, source: src });
});

test('stretch with a 0 sliver throws', async () => {
  await assert.rejects(run(await simple(), 'pdf', { mode: 'stretch', sliverMm: 0 }), /sliver/i);
});

test('mark settings are only checked when marks are on', async () => {
  const src = await simple();
  await assert.rejects(run(src, 'pdf', { markLenMm: 0 }), /Mark length/);
  await assert.rejects(run(src, 'pdf', { markWeightPt: NaN }), /Line weight/);
  await assert.rejects(run(src, 'pdf', { markOffsetMm: -1 }), /Offset/);
  await run(src, 'pdf', { marks: false, markLenMm: 0 });
});

test('image dpi must be positive (images only)', async () => {
  await assert.rejects(run(fx.png(), 'png', { imageDpi: 0 }), /dpi/);
  await run(await simple(), 'pdf', { imageDpi: NaN });
});

test('half-filled or non-positive trim W/H throws', async () => {
  const src = await simple();
  await assert.rejects(run(src, 'pdf', { trimWMm: 50 }), /both/);
  await assert.rejects(run(src, 'pdf', { trimWMm: 50, trimHMm: NaN }), /Trim width and height/);
  await assert.rejects(run(src, 'pdf', { trimWMm: 0, trimHMm: 50 }), /Trim width and height/);
  await assert.rejects(run(src, 'pdf', { trimWMm: -5, trimHMm: 50 }), /Trim width and height/);
});

// ---------- box normalisation (phase 1c) ----------

test('reversed MediaBox is normalised', async () => {
  const src = await fx.page({ media: fx.rect(300, 400, -300, -400), content: fx.fill(fx.rect(0, 0, 300, 400), [0, 0, 0, 0.8]) });
  const r = await run(src, 'pdf', { marks: false });
  assert.ok(Math.abs(r.pages[0].wMm - 105.833) < 0.05 && Math.abs(r.pages[0].hMm - 141.111) < 0.05, JSON.stringify(r.pages));
});

test('zero-area MediaBox throws', async () => {
  const src = await fx.page({ media: fx.rect(0, 0, 0, 0) });
  await assert.rejects(run(src, 'pdf'), /Page 1 has an empty MediaBox/);
});

test('TrimBox bigger than the MediaBox warns', async () => {
  const src = await fx.page({
    media: [100 * MM, 70 * MM], trim: fx.mmRect(-5, -5, 110, 80), content: fx.fill(fx.mmRect(0, 0, 100, 70), [0, 0, 0, 0.8]),
  });
  const r = await run(src, 'pdf', { marks: false });
  assert.ok(r.warnings.some((w) => /TrimBox extends beyond the page/.test(w)), r.warnings.join('|'));
});

async function hasTransparencyGroup(bytes) {
  const doc = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
  const S = PDFLib.PDFName.of('S'), T = PDFLib.PDFName.of('Transparency');
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const d = obj instanceof PDFLib.PDFRawStream ? obj.dict : obj;
    const g = d && d.lookup ? d.lookup(PDFLib.PDFName.of('Group')) : null;
    if (g && g.get && g.get(S) === T) return true;
  }
  return false;
}

test('default options: centre clip is the TrimBox and no transparency group', async () => {
  const trim = fx.mmRect(10, 10, 90, 60);
  const src = await fx.page({ media: [120 * MM, 90 * MM], trim, content: fx.fill(trim, [1, 0, 0, 0]) });
  const { hideSeams, ...defaults } = base;
  const r = await addBleed(PDFLib, src, 'pdf', { ...defaults, marks: false });
  await checkOutput(r.bytes, { trimMm: [90, 60], bleedMm: 3, source: src, exactCentreClip: true });
  assert.equal(await hasTransparencyGroup(r.bytes), false);
});

test('hideSeams: true still adds transparency groups', async () => {
  const trim = fx.mmRect(10, 10, 90, 60);
  const src = await fx.page({ media: [120 * MM, 90 * MM], trim, content: fx.fill(trim, [1, 0, 0, 0]) });
  const r = await run(src, 'pdf', { marks: false, hideSeams: true });
  assert.equal(await hasTransparencyGroup(r.bytes), true);
});

// ---------- page content copied once (phase 4a) ----------

test('single content stream: raw bytes and /Filter reused as is', async () => {
  const src = await simple();
  const r = await run(src, 'pdf', { marks: false });
  await checkOutput(r.bytes, { trimMm: [100, 70], bleedMm: 3, source: src, rawContent: true });
});

test('large page (25k operators): output stays within 10% of the source size', async () => {
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const ops = [];
  for (let i = 0; i < 5000; i++) {
    ops.push(`${(rnd()).toFixed(3)} ${(rnd()).toFixed(3)} 0 0 k ${(rnd() * 280).toFixed(2)} ${(rnd() * 190).toFixed(2)} ${(rnd() * 20).toFixed(2)} ${(rnd() * 20).toFixed(2)} re f`);
  }
  // 5000 x (q, k, re, f, Q) = 25k operators
  const src = await fx.page({ media: [100 * MM, 70 * MM], content: ops.map((o) => `q ${o} Q`).join('\n') });
  const r = await run(src, 'pdf', { marks: false });
  await checkOutput(r.bytes, { trimMm: [100, 70], bleedMm: 3, source: src, rawContent: true });
  const ratio = r.bytes.length / src.length;
  assert.ok(ratio < 1.1, `output ${r.bytes.length} B vs source ${src.length} B (x${ratio.toFixed(2)})`);
});

test('multi-stream page: decoded content joined and equal', async () => {
  const src = await fx.page({
    media: [100 * MM, 70 * MM], split: true,
    content: [fx.fill(fx.mmRect(0, 0, 50, 70), [1, 0, 0, 0]), fx.fill(fx.mmRect(50, 0, 50, 70), [0, 1, 0, 0]), fx.dieline(fx.mmRect(5, 5, 90, 60))],
  });
  const r = await run(src, 'pdf', { marks: false });
  await checkOutput(r.bytes, { trimMm: [100, 70], bleedMm: 3, source: src });
});

test('single stream with extra dict keys: decoded and recompressed', async () => {
  const src = await fx.page({ media: [100 * MM, 70 * MM], content: fx.fill(fx.mmRect(0, 0, 100, 70), [0, 0, 1, 0]) }, {
    setup: (doc) => {
      const c = doc.getPages()[0].node.lookup(PDFLib.PDFName.of('Contents'));
      doc.context.lookup(c.get(0)).dict.set(PDFLib.PDFName.of('DL'), PDFLib.PDFNumber.of(42));
    },
  });
  const r = await run(src, 'pdf', { marks: false });
  const out = await checkOutput(r.bytes, { trimMm: [100, 70], bleedMm: 3, source: src });
  // No leftover copy of the source content stream: only the Art form carries /DL-free content.
  for (const [, obj] of out.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFLib.PDFRawStream) assert.equal(obj.dict.get(PDFLib.PDFName.of('DL')), undefined, 'orphan source stream copied');
  }
});
