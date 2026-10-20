// Keep the file's own bleed (phase 6a).
const test = require('node:test');
const assert = require('node:assert/strict');
const PDFLib = require('pdf-lib');
const { addBleed } = require('../src/bleed.js');
const fx = require('./fixtures.js');
const { checkOutput, box, pageStreams } = require('./invariants.js');

const MM = fx.MM;
const base = {
  bleedMm: 3, mode: 'mirror', sliverMm: 0.5, marks: true, markOffsetMm: 3, markLenMm: 5,
  markWeightPt: 0.25, keepBleed: true,
};
const run = (bytes, o = {}) => addBleed(PDFLib, bytes, 'pdf', { ...base, ...o });
const has = (r, re) => r.warnings.some((w) => re.test(w));
const dump = (r) => r.warnings.join('|');

// 90 x 60 mm trim with `l b r t` mm of artwork around it (cyan trim, magenta bleed).
function bled([l, b, r, t], extra = {}) {
  const trim = fx.mmRect(l, b, 90, 60);
  return fx.page({
    media: [(l + 90 + r) * MM, (b + 60 + t) * MM], trim,
    content: [fx.fill(fx.mmRect(0, 0, l + 90 + r, b + 60 + t), [0, 1, 0, 0]), fx.fill(trim, [1, 0, 0, 0])].join('\n'),
    ...extra,
  });
}

async function content(bytes) {
  const doc = await PDFLib.PDFDocument.load(bytes);
  const node = doc.getPage(0).node;
  return { doc, node, text: pageStreams(doc, node).join('\n') };
}
const dos = (text) => (text.match(/\/Art[-\w]*\s+Do\b/g) || []).length;

test('5 mm of real bleed, 3 mm asked: drawn once, clipped to the BleedBox, unflipped', async () => {
  const src = await bled([5, 5, 5, 5]);
  const r = await run(src);
  assert.ok(has(r, /^Kept the file's own 3 mm bleed\.$/), dump(r));
  assert.ok(!has(r, /replaced by the new bleed/), dump(r));
  await checkOutput(r.bytes, { trimMm: [90, 60], bleedMm: 3, marks: true, source: src, rawContent: true });
  const { node, text } = await content(r.bytes);
  assert.equal(dos(text), 1, 'one Do');
  const bleed = box(node, 'BleedBox'), trim = box(node, 'TrimBox');
  const m = /q\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+re\s+W\s+n\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+cm/.exec(text);
  assert.ok(m, 'clip + cm not found');
  const [x, y, w, h, a, bb, c, d, e, f] = m.slice(1).map(Number);
  const eq = (p, q) => Math.abs(p - q) < 0.01;
  assert.ok(eq(x, bleed.x0) && eq(y, bleed.y0) && eq(x + w, bleed.x1) && eq(y + h, bleed.y1), 'clip is the BleedBox');
  assert.deepEqual([a, bb, c, d], [1, 0, 0, 1], 'not flipped or scaled');
  // The source trim corner lands on the output trim corner.
  assert.ok(eq(5 * MM + e, trim.x0) && eq(5 * MM + f, trim.y0), `offset ${e}, ${f}`);
  assert.ok(!/\/S\s*\/Transparency/.test(Buffer.from(r.bytes).toString('latin1')), 'no transparency');
});

test('kept bleed has no pieces or groups', async () => {
  const r = await run(await bled([5, 5, 5, 5]), { marks: false });
  const { text } = await content(r.bytes);
  assert.equal(dos(text), 1);
  assert.ok(!/\/S\s*\/Transparency/.test(Buffer.from(r.bytes).toString('latin1')));
});

test('2 mm of bleed, 3 mm asked: mirrored', async () => {
  const src = await bled([2, 2, 2, 2]);
  const r = await run(src, { marks: false });
  assert.ok(!has(r, /Kept the file's own/), dump(r));
  assert.ok(has(r, /already has 2\.0 mm or more beyond the trim; it is replaced/), dump(r));
  await checkOutput(r.bytes, { trimMm: [90, 60], bleedMm: 3, source: src, exactCentreClip: true });
  assert.equal(dos((await content(r.bytes)).text), 9, 'centre + 8 bleed pieces');
});

test('bleed on only some sides: mirrored, with a warning', async () => {
  const r = await run(await bled([5, 5, 5, 1]), { marks: false });
  assert.ok(has(r, /^File has bleed on only some sides; mirrored bleed used instead\.$/), dump(r));
  assert.ok(!has(r, /Kept the file's own|replaced by the new bleed/), dump(r));
  assert.equal(dos((await content(r.bytes)).text), 9);
});

test('a BleedBox smaller than the bleed asked limits what can be kept', async () => {
  const src = await bled([5, 5, 5, 5], { bleed: fx.mmRect(3, 3, 94, 64) }); // 2 mm around the trim
  const r = await run(src, { marks: false });
  assert.ok(!has(r, /Kept the file's own/), dump(r));
  assert.equal(dos((await content(r.bytes)).text), 9);
  const ok = await run(src, { marks: false, bleedMm: 2 });
  assert.ok(has(ok, /Kept the file's own 2 mm bleed/), dump(ok));
});

test('keepBleed off (the API default) mirrors as before', async () => {
  const r = await run(await bled([5, 5, 5, 5]), { marks: false, keepBleed: undefined });
  assert.ok(!has(r, /Kept the file's own/), dump(r));
  assert.ok(has(r, /replaced by the new bleed/), dump(r));
  assert.equal(dos((await content(r.bytes)).text), 9);
});

test('not used with Set size, crop marks or a TrimBox equal to the page', async () => {
  const set = await run(await bled([5, 5, 5, 5]), { marks: false, trimWMm: 90, trimHMm: 60 });
  assert.ok(!has(set, /Kept the file's own/), dump(set));
  const trim = fx.mmRect(10, 10, 90, 60);
  const marks = await fx.page({
    media: [110 * MM, 80 * MM], content: [fx.fill(fx.mmRect(0, 0, 110, 80), [0, 1, 0, 0]), fx.cropMarks(trim)].join('\n'),
  });
  const cm = await run(marks, { marks: false });
  assert.ok(has(cm, /found from the crop marks/), dump(cm));
  assert.ok(!has(cm, /Kept the file's own/), dump(cm));
  const same = await fx.page({ media: [100 * MM, 70 * MM], trim: fx.mmRect(0, 0, 100, 70), content: fx.fill(fx.mmRect(0, 0, 100, 70)) });
  const sr = await run(same, { marks: false });
  assert.ok(!has(sr, /Kept the file's own/), dump(sr));
});

test('rotated page: kept bleed lines up with the rotated trim', async () => {
  const src = await bled([5, 5, 5, 5], { rotate: 90 });
  const r = await run(src);
  assert.ok(has(r, /Kept the file's own 3 mm bleed/), dump(r));
  await checkOutput(r.bytes, { trimMm: [60, 90], bleedMm: 3, marks: true, source: src });
  const { node, text } = await content(r.bytes);
  const trim = box(node, 'TrimBox');
  const m = /re\s+W\s+n\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+cm/.exec(text);
  const [a, b, c, d, e, f] = m.slice(1).map(Number);
  const T = (x, y) => [a * x + c * y + e, b * x + d * y + f];
  const pts = [T(5 * MM, 5 * MM), T(95 * MM, 65 * MM)];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const eq = (p, q) => Math.abs(p - q) < 0.01;
  assert.ok(eq(Math.min(...xs), trim.x0) && eq(Math.max(...xs), trim.x1), `x ${xs} vs ${trim.x0}..${trim.x1}`);
  assert.ok(eq(Math.min(...ys), trim.y0) && eq(Math.max(...ys), trim.y1), `y ${ys} vs ${trim.y0}..${trim.y1}`);
});

test('PDF/X-1a source with kept bleed stays at its version', async () => {
  const src = await bled([5, 5, 5, 5], {});
  // Re-save as 1.3 with an X-1a claim in Info.
  const doc = await PDFLib.PDFDocument.load(src);
  doc.setTitle('x');
  doc.getInfoDict().set(PDFLib.PDFName.of('GTS_PDFXVersion'), PDFLib.PDFString.of('PDF/X-1a:2001'));
  const bytes = await doc.save({ useObjectStreams: false });
  bytes[5] = '1'.charCodeAt(0); bytes[7] = '3'.charCodeAt(0);
  const r = await run(bytes);
  assert.ok(has(r, /Kept the file's own/), dump(r));
  assert.equal(Buffer.from(r.bytes.subarray(0, 8)).toString('latin1'), '%PDF-1.3');
  assert.ok(!/\/S\s*\/Transparency/.test(Buffer.from(r.bytes).toString('latin1')));
});

test('the same warning on several pages is listed once, with its pages', async () => {
  const spec = (l) => {
    const trim = fx.mmRect(l, l, 90, 60);
    return { media: [(90 + 2 * l) * MM, (60 + 2 * l) * MM], trim,
      content: fx.fill(fx.mmRect(0, 0, 90 + 2 * l, 60 + 2 * l), [0, 1, 0, 0]) };
  };
  const all = await run(await fx.pdf([spec(2), spec(2), spec(2)]), { marks: false });
  assert.ok(has(all, /^All pages: already has 2\.0 mm or more beyond the trim/), dump(all));
  assert.ok(!has(all, /^Page \d/), dump(all));
  const some = await run(await fx.pdf([spec(2), spec(2), spec(5), spec(2)]), { marks: false });
  assert.ok(has(some, /^Pages 1–2, 4: already has 2\.0 mm/), dump(some));
  assert.ok(has(some, /^Page 3: kept the file's own/), dump(some));
});
