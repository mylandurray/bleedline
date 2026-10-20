const test = require('node:test');
const assert = require('node:assert');
const { edgeLine } = require('../src/bleed.js');

// Rows parallel to the edge, rows[0] on the trim: `edge` colour for the first `gap` px, `fill` after.
const S = 2400 / 72;
function strip(fill, gap = 0, edge = [255, 255, 255], len = 400, depth = Math.ceil(2 * S), noise = 0) {
  const rows = [];
  for (let k = 0; k < depth; k++) {
    const row = new Uint8ClampedArray(len * 4);
    for (let j = 0; j < len; j++) {
      const c = k < gap ? edge : noise ? fill.map((v) => v + (((j * 7 + k * 13) % 5) - 2) * noise) : fill;
      row.set([...c, 255], j * 4);
    }
    rows.push(row);
  }
  return rows;
}
const navy = [0, 21, 61];

test('edgeLine: background reaching the trim is fine', () => {
  assert.strictEqual(edgeLine(strip(navy), S), null);
});

test('edgeLine: white sliver (0.07 pt) along the trim is found', () => {
  const r = edgeLine(strip(navy, 2), S);
  assert.ok(r);
  assert.ok(r.lighter);
  assert.ok(Math.abs(r.widthPt - 2 / S) < 1e-9);
});

test('edgeLine: a dark hairline on a light background is found, not lighter', () => {
  const r = edgeLine(strip([240, 240, 240], 3, [0, 0, 0]), S);
  assert.ok(r && !r.lighter);
});

test('edgeLine: white artwork with a white edge is fine', () => {
  assert.strictEqual(edgeLine(strip([255, 255, 255], 2), S), null);
});

test('edgeLine: slight noise in a flat colour is ignored', () => {
  assert.strictEqual(edgeLine(strip(navy, 0, undefined, 400, undefined, 4), S), null);
});

test('edgeLine: a wide border (over 1 pt) is not reported as a hairline', () => {
  assert.strictEqual(edgeLine(strip(navy, Math.round(1.1 * S)), S), null);
});

test('centreOnly: same page geometry, only the trim area drawn', async () => {
  const PDFLib = require('pdf-lib');
  const { addBleed } = require('../src/bleed.js');
  const fx = require('./fixtures.js');
  const trim = fx.mmRect(10, 10, 90, 60);
  const src = await fx.page({ media: [120 * fx.MM, 90 * fx.MM], trim, content: fx.fill(trim, [0, 0.5, 1, 0]) });
  const o = { bleedMm: 3, mode: 'mirror', sliverMm: 0.5, marks: true, markOffsetMm: 3, markLenMm: 5, markWeightPt: 0.25 };
  const full = await addBleed(PDFLib, src, 'pdf', o);
  const centre = await addBleed(PDFLib, src, 'pdf', { ...o, centreOnly: true });
  assert.deepStrictEqual(centre.pages.map((p) => p.geo), full.pages.map((p) => p.geo));
  const doc = await PDFLib.PDFDocument.load(centre.bytes);
  const page = doc.getPage(0);
  const text = Buffer.from(PDFLib.decodePDFRawStream(doc.context.lookup(page.node.Contents().get(0))).decode()).toString('latin1');
  assert.strictEqual((text.match(/ Do\b/g) || []).length, 1);
});
