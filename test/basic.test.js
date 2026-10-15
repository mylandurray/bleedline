const test = require('node:test');
const PDFLib = require('pdf-lib');
const { addBleed } = require('../src/bleed.js');
const fx = require('./fixtures.js');
const { checkOutput } = require('./invariants.js');

const MM = fx.MM;
const base = {
  bleedMm: 3, mode: 'mirror', sliverMm: 0.5, marks: true, markOffsetMm: 3, markLenMm: 5,
  markWeightPt: 0.25,
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
  const r = await run(fx.png({ width: 300, height: 150, dpi: 150 }), 'png');
  await checkOutput(r.bytes, { trimMm: [50.8, 25.4], bleedMm: 3, marks: true, pages: 1 });
});

test('PNG with alpha (decode path)', async () => {
  const r = await run(fx.png({ width: 300, height: 150, alpha: true, dpi: 150 }), 'png', { marks: false });
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

test('image with no dpi saved asks for one, then uses the dpi entered', async () => {
  const png = fx.png({ width: 300, height: 150 });
  await assert.rejects(run(png, 'png'), (e) => e.code === 'NEED_DPI' && /no dpi saved/.test(e.message));
  await assert.rejects(run(png, 'png', { imageDpi: 0 }), /dpi must be more than 0/);
  // 300 x 150 px at 150 dpi = 50.8 x 25.4 mm
  const r = await run(png, 'png', { imageDpi: 150 });
  await checkOutput(r.bytes, { trimMm: [50.8, 25.4], bleedMm: 3, marks: true, pages: 1 });
  assert.ok(r.warnings.some((w) => /placed at 150 dpi as entered/.test(w)), r.warnings.join('|'));
});

test("an image's own dpi wins over the dpi entered", async () => {
  const r = await run(fx.jpg({ width: 600, height: 300, dpi: 300 }), 'jpg', { imageDpi: 72 });
  await checkOutput(r.bytes, { trimMm: [50.8, 25.4], bleedMm: 3, marks: true, pages: 1 });
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

test('centre clip is the TrimBox and no transparency group', async () => {
  const trim = fx.mmRect(10, 10, 90, 60);
  const src = await fx.page({ media: [120 * MM, 90 * MM], trim, content: fx.fill(trim, [1, 0, 0, 0]) });
  const r = await addBleed(PDFLib, src, 'pdf', { ...base, marks: false });
  await checkOutput(r.bytes, { trimMm: [90, 60], bleedMm: 3, source: src, exactCentreClip: true });
  assert.equal(await hasTransparencyGroup(r.bytes), false);
});

test('result reports each page\'s geometry for the preview', async () => {
  const trim = fx.mmRect(10, 10, 90, 60);
  const src = await fx.page({ media: [120 * MM, 90 * MM], trim, content: fx.fill(trim, [1, 0, 0, 0]) });
  const r = await run(src, 'pdf', { bleedMm: 3, markOffsetMm: 2, markLenMm: 4, keepBleed: false });
  const g = r.pages[0].geo;
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  assert.ok(near(g.w, 90 * MM) && near(g.h, 60 * MM) && near(g.b, 3 * MM), JSON.stringify(g));
  assert.ok(near(g.x, 8 * MM) && near(g.pw, 90 * MM + 16 * MM), JSON.stringify(g)); // margin = max(3, 2 + 4) + 2 mm
  assert.equal(g.pieces, true);
  assert.ok(near(g.marks.off, 2 * MM) && near(g.marks.len, 4 * MM));
  assert.equal(await hasTransparencyGroup(r.bytes), false);
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

// ---------- size check: pages the same size get the same trim ----------

test('a page trimmed differently from the other pages of its size is refused', async () => {
  const full = fx.fill(fx.mmRect(0, 0, 216, 303), [0, 0, 1, 0]);
  const src = await fx.pdf([
    { media: [216 * MM, 303 * MM], trim: fx.mmRect(3, 3, 210, 297), content: full },
    { media: [216 * MM, 303 * MM], trim: fx.mmRect(50, 50, 100, 150), content: full },
    { media: [216 * MM, 303 * MM], trim: fx.mmRect(3, 3, 210, 297), content: full },
  ]);
  await assert.rejects(run(src, 'pdf'), /same size \(216\.0 × 303\.0 mm\).*most to 210\.0 × 297\.0 mm \(from TrimBox\), but page 2 \(100\.0 × 150\.0 mm, from TrimBox\)/);
  // Setting the trim by hand makes every page the same, so it goes through.
  const r = await run(src, 'pdf', { trimWMm: 210, trimHMm: 297 });
  await checkOutput(r.bytes, { trimMm: [210, 297], bleedMm: 3, pages: 3 });
});

test('pages of different sizes may have different trims; the result reports artwork and trim', async () => {
  const src = await fx.pdf([
    { media: [216 * MM, 303 * MM], trim: fx.mmRect(3, 3, 210, 297), content: fx.fill(fx.mmRect(0, 0, 216, 303)) },
    { media: [100 * MM, 70 * MM], content: fx.fill(fx.mmRect(0, 0, 100, 70)) },
  ]);
  const r = await run(src, 'pdf');
  assert.ok(Math.abs(r.pages[0].artWMm - 216) < 0.01 && Math.abs(r.pages[0].wMm - 210) < 0.01);
  assert.equal(r.pages[0].from, 'TrimBox');
  assert.equal(r.pages[1].from, 'page size');
  assert.ok(r.warnings.some((w) => /different ways on different pages \(TrimBox, page size\)/.test(w)), r.warnings.join('|'));
});

test('a trim much smaller than the artwork warns', async () => {
  const src = await fx.page({ media: [200 * MM, 200 * MM], trim: fx.mmRect(50, 50, 100, 100), content: fx.fill(fx.mmRect(0, 0, 200, 200)) });
  const r = await run(src, 'pdf');
  assert.ok(r.warnings.some((w) => /trim \(100\.0 × 100\.0 mm\) is much smaller than the artwork \(200\.0 × 200\.0 mm\)/.test(w)), r.warnings.join('|'));
});
