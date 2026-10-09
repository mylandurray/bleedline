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
  await checkOutput(r.bytes, { trimMm: [90, 60], bleedMm: 3, marks: true, source: src, pages: 1 });
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
