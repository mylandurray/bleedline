// Structural checks on AddBleed output. Invariants the current code does not meet yet are
// opt-in through `expect` flags; later phases switch them on.
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const PDFLib = require('pdf-lib');
const { PDFDocument, PDFName, PDFArray, PDFDict, PDFStream } = PDFLib;
const MM = 72 / 25.4;
const N = (s) => PDFName.of(s);

function box(node, name) {
  const a = node.lookupMaybe(N(name), PDFArray);
  if (!a) return null;
  const v = a.asArray().map((x) => x.asNumber());
  return { x0: v[0], y0: v[1], x1: v[2], y1: v[3] };
}
const within = (a, b, tol = 0.01) => a.x0 >= b.x0 - tol && a.y0 >= b.y0 - tol && a.x1 <= b.x1 + tol && a.y1 <= b.y1 + tol;

function decode(stream) {
  const raw = Buffer.from(stream.getContents());
  const f = stream.dict.get(N('Filter'));
  if (!f) return raw;
  const names = f instanceof PDFArray ? f.asArray().map(String) : [String(f)];
  assert.deepEqual(names, ['/FlateDecode'], 'unsupported filter in test decode');
  return zlib.inflateSync(raw);
}

/** Decoded content streams of a page, as an array of strings. */
function pageStreams(doc, node) {
  const c = node.lookup(N('Contents'));
  const list = c instanceof PDFArray ? c.asArray().map((r) => doc.context.lookup(r)) : [c];
  return list.map((s) => decode(s).toString('latin1'));
}

const squash = (s) => s.replace(/\s+/g, ' ').trim();

/** Points of every m / l operator after the registration colour is selected. */
function markPoints(content) {
  const i = content.indexOf('SCN');
  if (i < 0) return [];
  const pts = [], re = /(-?[\d.]+)\s+(-?[\d.]+)\s+[ml]\b/g, tail = content.slice(i);
  let m;
  while ((m = re.exec(tail))) pts.push([+m[1], +m[2]]);
  return pts;
}

/**
 * checkOutput(bytes, expect). expect:
 *   trimMm            [w, h], or one [w, h] per page (required)
 *   bleedMm           number, all four sides (required)
 *   pages             expected page count
 *   marks             true -> trim marks must exist and lie entirely outside the BleedBox
 *   source            source PDF bytes -> the Art XObject content (decoded) must equal the page content
 *   rawContent        true -> also compare the undecoded bytes and /Filter, single-stream pages
 *   exactCentreClip   true -> the first (centre) clip equals the TrimBox
 *                     (OPT-IN: only holds with hideSeams:false, fails with seams on)
 * Returns the loaded output PDFDocument for extra assertions.
 */
async function checkOutput(bytes, expect) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages();
  if (expect.pages != null) assert.equal(pages.length, expect.pages, 'page count');
  const src = expect.source ? await PDFDocument.load(expect.source, { updateMetadata: false }) : null;
  const tol = 0.01; // mm

  pages.forEach((pg, i) => {
    const tag = `page ${i + 1}: `, node = pg.node;
    const media = box(node, 'MediaBox'), bleed = box(node, 'BleedBox'), trim = box(node, 'TrimBox');
    assert.ok(media && bleed && trim, tag + 'MediaBox, BleedBox and TrimBox must all exist');
    for (const [nm, b] of [['MediaBox', media], ['BleedBox', bleed], ['TrimBox', trim]]) {
      assert.ok(b.x1 > b.x0 && b.y1 > b.y0, `${tag}${nm} has no positive size`);
    }
    assert.ok(within(trim, bleed), tag + 'TrimBox must lie inside BleedBox');
    assert.ok(within(bleed, media), tag + 'BleedBox must lie inside MediaBox');

    const [tw, th] = Array.isArray(expect.trimMm[0]) ? expect.trimMm[i] : expect.trimMm;
    const gw = (trim.x1 - trim.x0) / MM, gh = (trim.y1 - trim.y0) / MM;
    assert.ok(Math.abs(gw - tw) <= tol, `${tag}trim width ${gw} mm, wanted ${tw}`);
    assert.ok(Math.abs(gh - th) <= tol, `${tag}trim height ${gh} mm, wanted ${th}`);

    const sides = {
      left: (trim.x0 - bleed.x0) / MM, right: (bleed.x1 - trim.x1) / MM,
      bottom: (trim.y0 - bleed.y0) / MM, top: (bleed.y1 - trim.y1) / MM,
    };
    for (const [s, v] of Object.entries(sides)) {
      assert.ok(Math.abs(v - expect.bleedMm) <= tol, `${tag}${s} bleed ${v} mm, wanted ${expect.bleedMm}`);
    }

    const streams = pageStreams(doc, node), content = streams.join('\n');

    // Graphics state: every Do on the page sits inside q ... Q, and q/Q balance.
    let depth = 0;
    for (const t of content.split(/\s+/)) {
      if (t === 'q') depth++;
      else if (t === 'Q') { depth--; assert.ok(depth >= 0, tag + 'unbalanced Q in page content'); }
      else if (t === 'Do') assert.ok(depth > 0, tag + 'Do outside q ... Q');
    }
    assert.equal(depth, 0, tag + 'unbalanced q in page content');

    if (expect.exactCentreClip) {
      const m = /^\s*q\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+re\s+W\s+n/.exec(content);
      assert.ok(m, tag + 'first clip not found');
      const [x, y, w, h] = m.slice(1).map(Number), eq = (a, b) => Math.abs(a - b) < 0.01;
      assert.ok(eq(x, trim.x0) && eq(y, trim.y0) && eq(w, trim.x1 - trim.x0) && eq(h, trim.y1 - trim.y0),
        `${tag}centre clip [${x}, ${y}, ${w}, ${h}] is not the TrimBox`);
    }

    if (src) {
      // pdf-lib suffixes XObject names (/Art-123456), so find it by prefix.
      const xo = node.lookup(N('Resources'), PDFDict).lookup(N('XObject'), PDFDict);
      const key = xo.keys().find((k) => k.decodeText().startsWith('Art'));
      assert.ok(key, tag + 'no Art XObject');
      const art = xo.lookup(key, PDFStream);
      const srcNode = src.getPages()[i].node;
      const srcStreams = pageStreams(src, srcNode);
      // The Art form holds the page content as is (no added q ... Q: Do already saves and
      // restores the graphics state, and every Do in AddBleed's own content sits in q ... Q).
      const artText = squash(decode(art).toString('latin1'));
      assert.equal(artText, squash(srcStreams.join('\n')), tag + 'Art content differs from source');
      if (expect.rawContent) {
        assert.equal(srcStreams.length, 1, 'rawContent needs a single-stream source page');
        const c = srcNode.lookup(N('Contents'));
        const sc = c instanceof PDFArray ? src.context.lookup(c.get(0)) : c;
        assert.deepEqual(Buffer.from(art.getContents()), Buffer.from(sc.getContents()), tag + 'raw content bytes differ');
        assert.equal(String(art.dict.get(N('Filter'))), String(sc.dict.get(N('Filter'))), tag + 'content /Filter differs');
      }
    }

    if (expect.marks) {
      const pts = markPoints(content);
      assert.ok(pts.length >= 16, tag + 'expected trim marks');
      for (const [x, y] of pts) {
        const inside = x > bleed.x0 + 1e-6 && x < bleed.x1 - 1e-6 && y > bleed.y0 + 1e-6 && y < bleed.y1 - 1e-6;
        assert.ok(!inside, `${tag}mark point (${x}, ${y}) falls inside the BleedBox`);
      }
    }
  });
  return doc;
}

module.exports = { checkOutput, box, decode, pageStreams, MM };
