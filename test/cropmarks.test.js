// Crop-mark detection (phase 2): a false trim crops the artwork, so anything doubtful must
// fall back to the page size instead.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const PDFLib = require('pdf-lib');
const { addBleed, findCropMarks } = require('../src/bleed.js');
const fx = require('./fixtures.js');
const { checkOutput } = require('./invariants.js');

const MM = fx.MM;
const opts = {
  bleedMm: 3, mode: 'mirror', sliverMm: 0.5, marks: false, markOffsetMm: 3, markLenMm: 5,
  markWeightPt: 0.25, imageDpi: 300, useFileDpi: true, hideSeams: false,
};
const A4 = [210 * MM, 297 * MM];
const TRIM = fx.mmRect(25, 40, 160, 217); // centred on A4, 56% of the page
const marks = (o = {}) => fx.cropMarks(TRIM, { offset: 3 * MM, len: 5 * MM, ...o });

/** Run AddBleed on one page spec; returns { r, src }. */
async function run(spec, o = {}) {
  const src = await fx.page(spec);
  return { r: await addBleed(PDFLib, src, 'pdf', { ...opts, ...o }), src };
}
const says = (r, re) => assert.ok(r.warnings.some((w) => re.test(w)), r.warnings.join(' | '));
const never = (r, re) => assert.ok(!r.warnings.some((w) => re.test(w)), r.warnings.join(' | '));

/** Expect the crop-mark trim (mm). */
async function detects(spec, trimMm) {
  const { r, src } = await run(spec);
  await checkOutput(r.bytes, { trimMm, bleedMm: 3, source: src });
  says(r, /found from the crop marks/);
  return r;
}
/** Expect the page-size fallback (mm). */
async function fallsBack(spec, pageMm, why = /no TrimBox or crop marks/) {
  const { r, src } = await run(spec);
  await checkOutput(r.bytes, { trimMm: pageMm, bleedMm: 3, source: src });
  never(r, /found from the crop marks/);
  says(r, why);
  return r;
}
/** findCropMarks straight on the first page: { found, diag }. */
async function detect(bytes) {
  const doc = await PDFLib.PDFDocument.load(bytes);
  const pg = doc.getPages()[0], m = pg.getMediaBox();
  const diag = {};
  const found = findCropMarks(PDFLib, pg, { x0: m.x, y0: m.y, x1: m.x + m.width, y1: m.y + m.height }, diag);
  return { found, diag };
}

// ---------- the 2c fixture table ----------

test('A5 table of 80 x 40 pt cells, TrimBox = MediaBox (audit repro): page size', async () => {
  const media = [148 * MM, 210 * MM];
  await fallsBack({
    media, trim: fx.rect(0, 0, media[0], media[1]),
    content: fx.table(10, 17.6, 5, 14, 80, 40),
  }, [148, 210], /TrimBox is the same as the page (no trim set), and there are no crop marks/);
});

test('same table on a page that also has real crop marks: the crop-mark trim', async () => {
  await detects({
    media: A4,
    content: [marks(), fx.table(TRIM.x + 20, TRIM.y + 30, 4, 10, 80, 40)].join('\n'),
  }, [160, 217]);
});

async function inDesign({ bleedMm = 3, bleedMarks = true } = {}) {
  // A5 trim on an A5 + 20 mm sheet: marks 3 mm off the trim, 5 mm long, 0.25 pt, plus bleed
  // marks, and artwork that runs into the bleed.
  const media = [188 * MM, 250 * MM], trim = fx.mmRect(20, 20, 148, 210), b = bleedMm * MM;
  const bled = fx.rect(trim.x - b, trim.y - b, trim.w + 2 * b, trim.h + 2 * b);
  const cx = media[0] / 2, cy = media[1] / 2;
  return {
    media,
    content: [
      fx.fill(bled, [0, 0.1, 0.3, 0]), // background to the bleed edge
      fx.fill(fx.rect(bled.x, trim.y + 300, 250, 200), [0.7, 0.2, 0, 0]), // picture box bleeding off the left
      `q 0 0 0 1 K 0.5 w ${bled.x} ${trim.y + 120} m ${bled.x + bled.w} ${trim.y + 120} l S Q`, // full-width rule
      `q 0 1 0 0 K 4 w ${bled.x} ${trim.y + 60} m ${trim.x + 25} ${trim.y + 60} l S Q`, // heavy stroke into the bleed
      fx.dieline(fx.rect(trim.x + 28, trim.y + 28, trim.w - 56, trim.h - 56), { width: 0.25 }), // type-area frame
      fx.table(trim.x + 40, trim.y + 150, 4, 4, 70, 20, { width: 0.5 }),
      fx.cropMarks(trim, { offset: 3 * MM, len: 5 * MM, width: 0.25, bleedMarks: bleedMarks ? b : 0 }),
      fx.target(cx, 6 * MM), fx.target(cx, media[1] - 6 * MM), fx.target(6 * MM, cy), fx.target(media[0] - 6 * MM, cy),
    ],
  };
}

test('InDesign style: marks + bleed marks + artwork bleeding past the trim: the inner (trim) rectangle', async () => {
  const r = await detects(await inDesign(), [148, 210]);
  never(r, /of 8 marks/);
});

test('InDesign style with 2 mm bleed marks inside a 3 mm mark offset: the trim', async () => {
  await detects(await inDesign({ bleedMm: 2 }), [148, 210]);
});

test('InDesign style without bleed marks: the trim', async () => {
  const spec = await inDesign({ bleedMarks: false });
  const { found } = await detect(await fx.page(spec));
  assert.equal(found.score, 8);
  await detects(spec, [148, 210]);
});

test('Acrobat "Add printer marks" style (marks inside a form XObject): detected', async () => {
  const [tx, ty] = [15, -20];
  const shifted = fx.rect(TRIM.x - tx, TRIM.y - ty, TRIM.w, TRIM.h);
  await detects({
    media: A4,
    resources: async (pg) => fx.addForm(pg, 'PM', fx.cropMarks(shifted, { offset: 3 * MM, len: 5 * MM }), {
      bbox: [-tx, -ty, A4[0] - tx, A4[1] - ty], matrix: [1, 0, 0, 1, tx, ty],
    }),
    content: [fx.fill(TRIM, [0, 0, 1, 0]), 'q /PM Do Q'],
  }, [160, 217]);
});

test('MediaBox not at the origin (as Illustrator writes it): detected', async () => {
  const [ox, oy] = [-300, 150];
  const trim = fx.rect(TRIM.x + ox, TRIM.y + oy, TRIM.w, TRIM.h);
  await detects({
    media: fx.rect(ox, oy, A4[0], A4[1]),
    content: fx.cropMarks(trim, { offset: 3 * MM, len: 5 * MM, bleedMarks: 3 * MM }),
  }, [160, 217]);
});

test('marks with 0 offset (touching the corner): detected', async () => {
  await detects({ media: A4, content: marks({ offset: 0 }) }, [160, 217]);
});

test('7 of 8 marks: detected, warning says 7 of 8', async () => {
  const r = await detects({ media: A4, content: marks({ omit: [5] }) }, [160, 217]);
  says(r, /\(7 of 8 marks\)/);
});

test('6 of 8 marks: page size', async () => {
  await fallsBack({ media: A4, content: marks({ omit: [0, 5] }) }, [210, 297]);
});

test('marks on a hidden layer: page size', async () => {
  await fallsBack({
    media: A4,
    resources: async (pg, doc) => fx.addProperty(pg, 'MC0', fx.addOCG(doc, 'Marks', { on: false })),
    content: ['/OC /MC0 BDC', marks(), 'EMC'],
  }, [210, 297]);
});

test('marks on a visible layer: detected', async () => {
  await detects({
    media: A4,
    resources: async (pg, doc) => fx.addProperty(pg, 'MC0', fx.addOCG(doc, 'Marks', { on: true })),
    content: ['/Artifact BMC', '/OC /MC0 BDC', marks(), 'EMC', 'EMC'],
  }, [160, 217]);
});

test('marks under an OCMD whose layers are all off: page size', async () => {
  await fallsBack({
    media: A4,
    resources: async (pg, doc) => {
      const a = fx.addOCG(doc, 'A', { on: false }), b = fx.addOCG(doc, 'B', { on: false });
      fx.addProperty(pg, 'MD', fx.addOCMD(doc, [a, b]));
    },
    content: ['/OC /MD BDC', marks(), 'EMC'],
  }, [210, 297]);
});

test('marks in a form XObject with /OC on a hidden layer: page size', async () => {
  await fallsBack({
    media: A4,
    resources: async (pg, doc) => fx.addForm(pg, 'PM', marks(), { oc: fx.addOCG(doc, 'Marks', { on: false }) }),
    content: 'q /PM Do Q',
  }, [210, 297]);
});

test('marks outside a form\'s BBox: page size', async () => {
  await fallsBack({
    media: A4,
    resources: async (pg) => fx.addForm(pg, 'PM', marks(), { bbox: [TRIM.x, TRIM.y, TRIM.x + TRIM.w, TRIM.y + TRIM.h] }),
    content: 'q /PM Do Q',
  }, [210, 297]);
});

test('dieline rectangle drawn as 4 segments on the trim, no marks: page size', async () => {
  const { x, y, w, h } = TRIM;
  await fallsBack({
    media: A4,
    content: `q 0 1 0 0 K 0.5 w ${x} ${y} m ${x + w} ${y} l S ${x + w} ${y} m ${x + w} ${y + h} l S ` +
      `${x + w} ${y + h} m ${x} ${y + h} l S ${x} ${y + h} m ${x} ${y} l S Q`,
  }, [210, 297]);
});

test('crop marks plus a dieline drawn on the trim: page size (marks never draw the trim)', async () => {
  await fallsBack({ media: A4, content: [marks(), fx.dieline(TRIM)] }, [210, 297]);
});

test('3 pt thick "marks": page size', async () => {
  await fallsBack({ media: A4, content: marks({ width: 3 }) }, [210, 297]);
});

test('line width follows the CTM: 2 pt at 0.5x is a mark, 1 pt at 2x is not', async () => {
  const half = fx.cropMarks(fx.rect(TRIM.x * 2, TRIM.y * 2, TRIM.w * 2, TRIM.h * 2), { offset: 6 * MM, len: 10 * MM, width: 2 });
  await detects({ media: A4, content: `q 0.5 0 0 0.5 0 0 cm ${half} Q` }, [160, 217]);
  const dbl = fx.cropMarks(fx.rect(TRIM.x / 2, TRIM.y / 2, TRIM.w / 2, TRIM.h / 2), { offset: 1.5 * MM, len: 2.5 * MM, width: 1 });
  await fallsBack({ media: A4, content: `q 2 0 0 2 0 0 cm ${dbl} Q` }, [210, 297]);
});

test('two unrelated, non-concentric mark sets: page size with the ambiguity warning', async () => {
  const other = fx.mmRect(35, 50, 160, 217);
  const spec = { media: A4, content: [marks(), fx.cropMarks(other, { offset: 3 * MM, len: 5 * MM })] };
  const { diag } = await detect(await fx.page(spec));
  assert.equal(diag.reason, 'ambiguous');
  await fallsBack(spec, [210, 297], /more than one possible set of crop marks/);
});

test('7 of 8 trim marks inside complete bleed marks: page size, not the bleed rectangle', async () => {
  await fallsBack({ media: A4, content: marks({ omit: [2], bleedMarks: 3 * MM }) }, [210, 297], /more than one possible set/);
});

test('over-budget content (500k operators): page size with the "too complex" warning', async () => {
  const filler = 'q Q\n'.repeat(250000);
  await fallsBack({ media: A4, content: [marks(), filler] }, [210, 297], /too complex to check for crop marks/);
});

test('findCropMarks returns { x0, y0, x1, y1, score }', async () => {
  const { found } = await detect(await fx.page({ media: A4, content: marks({ bleedMarks: 3 * MM }) }));
  const near = (a, b) => Math.abs(a - b) < 0.01;
  assert.ok(near(found.x0, TRIM.x) && near(found.y0, TRIM.y) && near(found.x1, TRIM.x + TRIM.w) && near(found.y1, TRIM.y + TRIM.h), JSON.stringify(found));
  assert.equal(found.score, 8);
});

// ---------- real files (optional, never committed) ----------
// test/samples/expected.json: { "file.pdf": { "trimMm": [210, 297] } }, files beside it.

const samples = path.join(__dirname, 'samples');
const expectedFile = path.join(samples, 'expected.json');
const expected = fs.existsSync(expectedFile) ? JSON.parse(fs.readFileSync(expectedFile, 'utf8')) : null;
if (!expected) {
  test('real crop-mark samples', { skip: 'no test/samples/expected.json' }, () => {});
} else {
  for (const [name, want] of Object.entries(expected)) {
    const file = path.join(samples, name);
    test(`sample ${name}`, { skip: fs.existsSync(file) ? false : 'file missing' }, async () => {
      const src = new Uint8Array(fs.readFileSync(file));
      const r = await addBleed(PDFLib, src, 'pdf', opts);
      await checkOutput(r.bytes, { trimMm: want.trimMm, bleedMm: 3 });
    });
  }
}
