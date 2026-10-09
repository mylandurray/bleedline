// In-memory fixture builders (no binary files are committed).
// All rectangles are { x, y, w, h } in PDF points; mmRect() takes millimetres.
const zlib = require('node:zlib');
const PDFLib = require('pdf-lib');
const { PDFDocument, PDFName } = PDFLib;

const MM = 72 / 25.4;
const n = (v) => +Number(v).toFixed(4);
const rect = (x, y, w, h) => ({ x, y, w, h });
const mmRect = (x, y, w, h) => rect(x * MM, y * MM, w * MM, h * MM);

// ---------- content snippets (return PDF content-stream strings) ----------

/**
 * Crop marks around `trim`; `bleedMarks` (pt) adds a second, outer set at that bleed distance.
 * `omit` lists trim marks (0-7) to leave out: 0-3 vertical (left-bottom, left-top, right-bottom,
 * right-top), 4-7 horizontal (bottom-left, bottom-right, top-left, top-right).
 */
function cropMarks(trim, { offset = 9, len = 18, width = 0.25, gray = 0, bleedMarks = 0, omit = [] } = {}) {
  const out = [`q ${gray} G ${n(width)} w`];
  const set = (d, skip) => {
    const xs = [trim.x - d, trim.x + trim.w + d], ys = [trim.y - d, trim.y + trim.h + d];
    const marks = [];
    for (const x of xs) {
      marks.push(`${n(x)} ${n(trim.y - offset)} m ${n(x)} ${n(trim.y - offset - len)} l S`);
      marks.push(`${n(x)} ${n(trim.y + trim.h + offset)} m ${n(x)} ${n(trim.y + trim.h + offset + len)} l S`);
    }
    for (const y of ys) {
      marks.push(`${n(trim.x - offset)} ${n(y)} m ${n(trim.x - offset - len)} ${n(y)} l S`);
      marks.push(`${n(trim.x + trim.w + offset)} ${n(y)} m ${n(trim.x + trim.w + offset + len)} ${n(y)} l S`);
    }
    marks.forEach((m, i) => { if (!skip.includes(i)) out.push(m); });
  };
  set(0, omit);
  if (bleedMarks) set(bleedMarks, []);
  out.push('Q');
  return out.join('\n');
}

/** Grid of per-cell `m l S` segments, as Word / Excel export tables. */
function table(x, y, cols, rows, cw, ch, { width = 0.5 } = {}) {
  const out = [`q 0 G ${n(width)} w`];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = x + c * cw, y0 = y + r * ch;
      out.push(`${n(x0)} ${n(y0)} m ${n(x0 + cw)} ${n(y0)} l S`);
      out.push(`${n(x0)} ${n(y0 + ch)} m ${n(x0 + cw)} ${n(y0 + ch)} l S`);
      out.push(`${n(x0)} ${n(y0)} m ${n(x0)} ${n(y0 + ch)} l S`);
      out.push(`${n(x0 + cw)} ${n(y0)} m ${n(x0 + cw)} ${n(y0 + ch)} l S`);
    }
  }
  out.push('Q');
  return out.join('\n');
}

/** Stroked rectangle (die line / frame). */
function dieline(r, { width = 0.5, cmyk = [0, 1, 1, 0] } = {}) {
  return `q ${cmyk.join(' ')} K ${n(width)} w ${n(r.x)} ${n(r.y)} ${n(r.w)} ${n(r.h)} re S Q`;
}

/** Filled rectangle; colour is [c,m,y,k], [r,g,b] or [g]. */
function fill(r, color = [0, 0, 0, 1]) {
  const op = color.length === 4 ? 'k' : color.length === 3 ? 'rg' : 'g';
  return `q ${color.join(' ')} ${op} ${n(r.x)} ${n(r.y)} ${n(r.w)} ${n(r.h)} re f Q`;
}

/** Registration target (circle approximated by curves, plus a cross-hair) centred on (x, y). */
function target(x, y, r = 8) {
  const k = 0.5523 * r;
  return [`q 0 G 0.25 w`,
    `${n(x + r)} ${n(y)} m ${n(x + r)} ${n(y + k)} ${n(x + k)} ${n(y + r)} ${n(x)} ${n(y + r)} c`,
    `${n(x - k)} ${n(y + r)} ${n(x - r)} ${n(y + k)} ${n(x - r)} ${n(y)} c`,
    `${n(x - r)} ${n(y - k)} ${n(x - k)} ${n(y - r)} ${n(x)} ${n(y - r)} c`,
    `${n(x + k)} ${n(y - r)} ${n(x + r)} ${n(y - k)} ${n(x + r)} ${n(y)} c S`,
    `${n(x - 1.6 * r)} ${n(y)} m ${n(x + 1.6 * r)} ${n(y)} l S`,
    `${n(x)} ${n(y - 1.6 * r)} m ${n(x)} ${n(y + 1.6 * r)} l S Q`].join('\n');
}

// ---------- resource helpers (use inside a spec's `resources` hook) ----------

/**
 * Add an optional-content group (layer) to the document; `on: false` lists it under
 * OCProperties /D /OFF. Returns the OCG's ref.
 */
function addOCG(doc, name, { on = true } = {}) {
  const ctx = doc.context, N = PDFName.of;
  const ref = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFLib.PDFString.of(name) }));
  let ocp = doc.catalog.lookup(N('OCProperties'));
  if (!ocp) {
    ocp = ctx.obj({ OCGs: [], D: { Order: [], ON: [], OFF: [] } });
    doc.catalog.set(N('OCProperties'), ocp);
  }
  ocp.lookup(N('OCGs')).push(ref);
  const d = ocp.lookup(N('D'));
  d.lookup(N('Order')).push(ref);
  d.lookup(N(on ? 'ON' : 'OFF')).push(ref);
  return ref;
}

/** Optional-content membership dictionary over `ocgs` (refs), policy P (AnyOn, AllOn, ...). */
function addOCMD(doc, ocgs, p = 'AnyOn') {
  return doc.context.register(doc.context.obj({ Type: 'OCMD', OCGs: ocgs, P: p }));
}

/** Name a layer (OCG or OCMD ref) in the page's /Properties, for `/OC /<name> BDC ... EMC`. */
function addProperty(pg, name, ref) {
  const N = PDFName.of, res = pg.node.Resources();
  let props = res.lookup(N('Properties'));
  if (!props) { props = pg.doc.context.obj({}); res.set(N('Properties'), props); }
  props.set(N(name), ref);
}

/**
 * Form XObject named `name` in the page's resources. bbox [x0 y0 x1 y1] (default: page),
 * matrix [a b c d e f], oc = OCG/OCMD ref. Draw it with `/<name> Do`.
 */
function addForm(pg, name, content, { bbox, matrix, oc } = {}) {
  const ctx = pg.doc.context, N = PDFName.of;
  const { width, height } = pg.getMediaBox();
  const dict = { Type: 'XObject', Subtype: 'Form', BBox: bbox || [0, 0, width, height] };
  if (matrix) dict.Matrix = matrix;
  if (oc) dict.OC = oc;
  const ref = ctx.register(ctx.flateStream(content, dict));
  pg.node.setXObject(N(name), ref);
  return ref;
}

// ---------- page / document builders ----------

const setBox = (pg, name, b) => pg.node.set(PDFName.of(name), pg.doc.context.obj([b.x, b.y, b.x + b.w, b.y + b.h]));

/**
 * Build a PDFDocument from one page spec or an array of them. A spec is:
 *   media  {x,y,w,h} or [w,h] (points; default A4)
 *   trim / crop / bleed / art   boxes as {x,y,w,h}
 *   rotate  0|90|180|270
 *   content string, or string[] (joined into one stream; with `split` one stream each)
 *   resources  async (pg, doc) => void   hook for fonts, form XObjects, OCGs, ExtGState ...
 * build()'s second argument { setup: async (doc) => void } edits the whole document
 * (catalog entries, OutputIntents, XMP, ...) before it is saved.
 */
async function build(specs, { setup } = {}) {
  const doc = await PDFDocument.create();
  for (const spec of Array.isArray(specs) ? specs : [specs]) {
    const m = Array.isArray(spec.media) ? rect(0, 0, spec.media[0], spec.media[1]) : spec.media || rect(0, 0, 595.28, 841.89);
    const pg = doc.addPage([m.w, m.h]);
    if (m.x || m.y) setBox(pg, 'MediaBox', m);
    const names = { crop: 'CropBox', trim: 'TrimBox', bleed: 'BleedBox', art: 'ArtBox' };
    for (const k of Object.keys(names)) if (spec[k]) setBox(pg, names[k], spec[k]);
    if (spec.rotate) pg.setRotation(PDFLib.degrees(spec.rotate));
    if (spec.resources) await spec.resources(pg, doc);
    const c = spec.content || '';
    const parts = Array.isArray(c) ? (spec.split ? c : [c.join('\n')]) : [c];
    const refs = parts.map((p) => doc.context.register(doc.context.flateStream(p)));
    pg.node.set(PDFName.of('Contents'), doc.context.obj(refs));
  }
  if (setup) await setup(doc);
  return doc;
}

/** One page spec -> PDF bytes. */
async function page(spec = {}, opts) {
  return (await build(spec, opts)).save({ useObjectStreams: false });
}

/** Array of page specs -> PDF bytes. */
async function pdf(specs, opts) {
  return (await build(specs, opts)).save({ useObjectStreams: false });
}

// ---------- small raster inputs, generated in code ----------

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Opaque RGB or RGBA (alpha:true) PNG. dpi > 0 adds a pHYs chunk. */
function png({ width = 40, height = 30, alpha = false, dpi = 0, pixel = (x, y) => [(x * 6) % 256, (y * 8) % 256, 128] } = {}) {
  const ch = alpha ? 4 : 3, stride = width * ch + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = pixel(x, y);
      for (let c = 0; c < ch; c++) raw[y * stride + 1 + x * ch + c] = c === 3 ? (p[3] ?? 255) : p[c];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2;
  const chunks = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr)];
  if (dpi) {
    const p = Buffer.alloc(9), ppm = Math.round(dpi / 0.0254);
    p.writeUInt32BE(ppm, 0); p.writeUInt32BE(ppm, 4); p[8] = 1;
    chunks.push(pngChunk('pHYs', p));
  }
  chunks.push(pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)));
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * Header-only JPEG (SOI, JFIF, SOF0, SOS stub, EOI). Not decodable as a picture, but AddBleed
 * passes JPEG data through untouched and only reads the header, so it is enough for structural
 * tests. comps is 1, 3 or 4; dpi writes the JFIF density.
 */
function jpg({ width = 40, height = 30, comps = 3, dpi = 0 } = {}) {
  const u16 = (v) => [(v >> 8) & 255, v & 255];
  const b = [0xff, 0xd8, 0xff, 0xe0, ...u16(16), 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, dpi ? 1 : 0, ...u16(dpi || 1), ...u16(dpi || 1), 0, 0];
  const sof = [8, ...u16(height), ...u16(width), comps];
  for (let i = 1; i <= comps; i++) sof.push(i, 0x11, 0);
  b.push(0xff, 0xc0, ...u16(sof.length + 2), ...sof);
  b.push(0xff, 0xda, ...u16(2 + 1 + comps * 2 + 3), comps);
  for (let i = 1; i <= comps; i++) b.push(i, 0);
  b.push(0, 63, 0, 0x00, 0xff, 0xd9);
  return new Uint8Array(b);
}

module.exports = {
  MM, rect, mmRect, cropMarks, table, dieline, fill, target, addOCG, addOCMD, addProperty, addForm,
  build, page, pdf, png, jpg,
};
