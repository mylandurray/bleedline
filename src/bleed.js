// Core: add mirrored/stretched bleed and trim marks to a PDF or image.
// Works in the browser (PDFLib global) and in Node (pass the pdf-lib module).
// Everything stays vector: the original page is copied once as a Form XObject
// and redrawn flipped/stretched into each bleed strip, clipped to that strip.
// The artwork itself is never re-encoded: PDF content streams, JPEG data and
// (where possible) PNG data are passed through byte-for-byte.

(function (root) {
  const MM = 72 / 25.4;

  // PDF matrices [a b c d e f]; mul(m1, m2) = apply m1 first, then m2.
  function mul(m1, m2) {
    const [a1, b1, c1, d1, e1, f1] = m1;
    const [a2, b2, c2, d2, e2, f2] = m2;
    return [
      a1 * a2 + b1 * c2, a1 * b2 + b1 * d2,
      c1 * a2 + d1 * c2, c1 * b2 + d1 * d2,
      e1 * a2 + f1 * c2 + e2, e1 * b2 + f1 * d2 + f2,
    ];
  }

  // Page coords -> "visual" coords where the trim box is [0,W]x[0,H], upright.
  function visualMatrix(box, rotate) {
    const { x0, y0, x1, y1 } = box;
    switch (((rotate % 360) + 360) % 360) {
      case 90: return [0, -1, 1, 0, -y0, x1];
      case 180: return [-1, 0, 0, -1, x1, y1];
      case 270: return [0, 1, -1, 0, y1, -x0];
      default: return [1, 0, 0, 1, -x0, -y0];
    }
  }

  // Image unit square -> upright [0,W]x[0,H], honouring the EXIF orientation tag.
  function orientMatrix(o, W, H) {
    switch (o) {
      case 2: return [-W, 0, 0, H, W, 0];
      case 3: return [-W, 0, 0, -H, W, H];
      case 4: return [W, 0, 0, -H, 0, H];
      case 5: return [0, -H, -W, 0, W, H];
      case 6: return [0, -H, W, 0, 0, H];
      case 7: return [0, H, W, 0, 0, 0];
      case 8: return [0, H, -W, 0, W, 0];
      default: return [W, 0, 0, H, 0, 0];
    }
  }

  // One axis of a cell transform: returns [scale, offset] mapping visual u -> output.
  // side -1 = before the trim, 0 = inside, +1 = after.
  // `off` shifts the bleed copy towards the trim so its own artwork edge sits
  // beyond the piece's clip (see the seam notes in addBleed).
  function axis(side, o, len, k, off) {
    if (side === 0) return [1, o];
    if (side < 0) return [-k, o + off];
    return [-k, o + len - off + k * len];
  }

  // Overlap (pt, ~0.26 mm) that hides on-screen anti-aliasing seams between pieces.
  const SEAM = 0.75;

  // PDF boxes may list their corners in any order, so normalise to min/max.
  const rect = (r) => ({
    x0: Math.min(r.x, r.x + r.width), x1: Math.max(r.x, r.x + r.width),
    y0: Math.min(r.y, r.y + r.height), y1: Math.max(r.y, r.y + r.height),
  });
  const mm = (pt) => (pt / MM).toFixed(1);

  // Common finished sizes (mm, portrait) used to spot files that already include bleed.
  const SIZES = { A3: [297, 420], A4: [210, 297], A5: [148, 210], A6: [105, 148], DL: [99, 210],
    'business card': [85, 55], 'business card ': [90, 55], 'business card  ': [90, 50] };
  function looksLikeBleed(wMm, hMm) {
    for (const bl of [2, 3, 5]) {
      for (const [name, [a, c]] of Object.entries(SIZES)) {
        const w = wMm - 2 * bl, h = hMm - 2 * bl;
        if ((Math.abs(w - a) < 0.6 && Math.abs(h - c) < 0.6) || (Math.abs(w - c) < 0.6 && Math.abs(h - a) < 0.6))
          return `${name.trim()} + ${bl} mm bleed`;
      }
    }
    return null;
  }

  // ---------- image parsing (no decoding, just metadata) ----------

  function u16(d, i, le) { return le ? d[i] | (d[i + 1] << 8) : (d[i] << 8) | d[i + 1]; }
  function u32(d, i, le) {
    return le ? (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16)) + d[i + 3] * 0x1000000
      : d[i] * 0x1000000 + ((d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]);
  }
  const ascii = (d, i, n) => String.fromCharCode(...d.subarray(i, i + n));

  function parseJpeg(d) {
    if (d[0] !== 0xff || d[1] !== 0xd8) throw new Error('Not a valid JPEG file');
    const r = { orientation: 1, dpi: null, adobe: false, icc: [] };
    let i = 2;
    while (i < d.length) {
      if (d[i] !== 0xff) { i++; continue; }
      const m = d[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
      const len = u16(d, i + 2), s = i + 4;
      if (m === 0xda || m === 0xd9) break; // start of scan
      if (m === 0xe0 && ascii(d, s, 5) === 'JFIF\0' && !r.dpi) {
        const units = d[s + 7], x = u16(d, s + 8);
        if (units === 1 && x > 1) r.dpi = x;
        if (units === 2 && x > 1) r.dpi = x * 2.54;
      } else if (m === 0xe1 && ascii(d, s, 6) === 'Exif\0\0') {
        const t = s + 6, le = ascii(d, t, 2) === 'II';
        const ifd = t + u32(d, t + 4, le), n = u16(d, ifd, le);
        let xres = null, unit = 2;
        for (let e = 0; e < n; e++) {
          const p = ifd + 2 + e * 12, tag = u16(d, p, le);
          if (tag === 0x0112) r.orientation = u16(d, p + 8, le);
          if (tag === 0x0128) unit = u16(d, p + 8, le);
          if (tag === 0x011a) { const o = t + u32(d, p + 8, le); xres = u32(d, o, le) / (u32(d, o + 4, le) || 1); }
        }
        if (xres > 1 && !r.exifDpi) r.exifDpi = unit === 3 ? xres * 2.54 : xres;
      } else if (m === 0xe2 && ascii(d, s, 12) === 'ICC_PROFILE\0') {
        r.icc.push({ seq: d[s + 12], data: d.subarray(s + 14, i + 2 + len) });
      } else if (m === 0xee && ascii(d, s, 5) === 'Adobe') {
        r.adobe = true;
      } else if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        r.bpc = d[s]; r.height = u16(d, s + 1); r.width = u16(d, s + 3); r.comps = d[s + 5];
      }
      i += 2 + len;
    }
    if (!r.width) throw new Error('JPEG has no image header');
    r.dpi = r.dpi || r.exifDpi || null;
    r.icc.sort((a, b) => a.seq - b.seq);
    r.iccBytes = r.icc.length ? concat(r.icc.map((c) => c.data)) : null;
    return r;
  }

  function parsePng(d) {
    if (ascii(d, 1, 3) !== 'PNG') throw new Error('Not a valid PNG file');
    const r = { idat: [], dpi: null };
    let i = 8;
    while (i < d.length) {
      const len = u32(d, i), type = ascii(d, i + 4, 4), s = i + 8;
      if (type === 'IHDR') {
        r.width = u32(d, s); r.height = u32(d, s + 4);
        r.bitDepth = d[s + 8]; r.colorType = d[s + 9]; r.interlace = d[s + 12];
      } else if (type === 'PLTE') r.plte = d.subarray(s, s + len);
      else if (type === 'tRNS') r.trns = true;
      else if (type === 'pHYs' && d[s + 8] === 1) r.dpi = u32(d, s) * 0.0254;
      else if (type === 'iCCP') {
        let z = s; while (d[z] !== 0 && z < s + 80) z++;
        r.iccZ = d.subarray(z + 2, s + len); // zlib data == PDF FlateDecode
      } else if (type === 'IDAT') r.idat.push(d.subarray(s, s + len));
      else if (type === 'IEND') break;
      i += 12 + len;
    }
    return r;
  }

  function concat(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  // ---------- crop mark detection ----------

  // Minimal content-stream reader: yields operands + operator, skipping strings,
  // dicts and inline images. Enough to follow paths, q/Q/cm and Do.
  function* tokens(d) {
    const n = d.length, ops = [];
    const ws = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
    const delim = (c) => ws(c) || c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 47 || c === 37 || c === 123 || c === 125;
    let i = 0;
    while (i < n) {
      const c = d[i];
      if (ws(c)) { i++; continue; }
      if (c === 37) { while (i < n && d[i] !== 10 && d[i] !== 13) i++; continue; } // comment
      if (c === 40) { // (string)
        let depth = 0;
        for (; i < n; i++) {
          if (d[i] === 92) { i++; continue; }
          if (d[i] === 40) depth++;
          else if (d[i] === 41 && --depth === 0) { i++; break; }
        }
        ops.push(null); continue;
      }
      if (c === 60 && d[i + 1] !== 60) { while (i < n && d[i] !== 62) i++; i++; ops.push(null); continue; } // <hex>
      if (c === 60 || c === 62) { i += 2; ops.push(null); continue; } // << >>
      if (c === 91 || c === 93 || c === 123 || c === 125) { i++; continue; }
      let j = i + 1;
      while (j < n && !delim(d[j])) j++;
      const t = String.fromCharCode(...d.subarray(i, j));
      i = j;
      if (c === 47) ops.push(t.slice(1)); // /Name
      else if (/^[+\-.\d]/.test(t)) ops.push(parseFloat(t));
      else if (t === 'BI') { // inline image: skip to EI
        while (i < n && !(ws(d[i - 1]) && d[i] === 69 && d[i + 1] === 73 && (i + 2 >= n || ws(d[i + 2])))) i++;
        i += 2; ops.length = 0;
      } else { yield [t, ops.slice()]; ops.length = 0; }
    }
  }

  // Short, axis-aligned stroked lines (and hairline-thin filled rects) in page space.
  function collectLines(PDFLib, page) {
    const { PDFName, PDFDict, PDFArray, PDFRawStream, decodePDFRawStream } = PDFLib;
    const N = (s) => PDFName.of(s);
    const ctx = page.doc.context;
    const lines = [];
    let budget = 400000; // operators; bail out on huge artwork
    const bytesOf = (s) => (s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents());

    function run(datas, res, ctm, depth) {
      const stack = [];
      let path = [], cur = null, start = null;
      const pt = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
      const seg = (a, c) => path.push([a, c]);
      for (const data of datas) {
        for (const [op, a] of tokens(data)) {
          if (--budget < 0) return;
          switch (op) {
            case 'q': stack.push(ctm); break;
            case 'Q': if (stack.length) ctm = stack.pop(); break;
            case 'cm': if (a.length === 6) ctm = mul(a, ctm); break;
            case 'm': cur = start = pt(a[0], a[1]); break;
            case 'l': { const p = pt(a[0], a[1]); if (cur) seg(cur, p); cur = p; break; }
            case 'c': cur = pt(a[4], a[5]); break;
            case 'v': case 'y': cur = pt(a[2], a[3]); break;
            case 'h': if (cur && start) seg(cur, start); cur = start; break;
            case 're': {
              const [x, y, w, h] = a; const p = [pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h)];
              path.push({ rect: p }); cur = start = p[0];
              break;
            }
            case 'S': case 's': case 'B': case 'B*': case 'b': case 'b*':
            case 'f': case 'F': case 'f*': case 'n': {
              const stroked = /^[SsBb]/.test(op), filled = op !== 'S' && op !== 's' && op !== 'n';
              for (const p of path) {
                if (p.rect) {
                  // A thin filled rectangle is drawn the same as a line.
                  if (!filled) { if (stroked) for (let k = 0; k < 4; k++) lines.push([p.rect[k], p.rect[(k + 1) % 4]]); continue; }
                  const xs = p.rect.map((q) => q[0]), ys = p.rect.map((q) => q[1]);
                  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
                  if (x1 - x0 < 1.5 && y1 - y0 > 2) lines.push([[(x0 + x1) / 2, y0], [(x0 + x1) / 2, y1]]);
                  else if (y1 - y0 < 1.5 && x1 - x0 > 2) lines.push([[x0, (y0 + y1) / 2], [x1, (y0 + y1) / 2]]);
                } else if (stroked) lines.push(p);
              }
              path = []; cur = start = null;
              break;
            }
            case 'Do': {
              if (depth > 6 || !res) break;
              const xd = res.lookupMaybe(N('XObject'), PDFDict);
              const x = xd && xd.lookup(N(a[0]));
              if (!x || !x.dict) break;
              const st = x.dict.lookup(N('Subtype'));
              if (!st || st.asString() !== '/Form') break;
              const fm = x.dict.lookupMaybe(N('Matrix'), PDFArray);
              const m = fm ? fm.asArray().map((v) => v.asNumber()) : [1, 0, 0, 1, 0, 0];
              let data; try { data = bytesOf(x); } catch (e) { break; }
              run([data], x.dict.lookupMaybe(N('Resources'), PDFDict) || res, mul(m, ctm), depth + 1);
              break;
            }
            default:
          }
        }
      }
    }

    const c = page.node.Contents();
    const streams = !c ? [] : c instanceof PDFArray ? c.asArray().map((r) => ctx.lookup(r)) : [c];
    const datas = [];
    for (const s of streams) { try { datas.push(bytesOf(s)); } catch (e) { return []; } }
    run(datas, page.node.Resources(), [1, 0, 0, 1, 0, 0], 0);
    return lines;
  }

  // Look for printer's crop marks: short lines that extend the trim edges out
  // into the margin at each corner. Returns {x0,y0,x1,y1} in page space or null.
  function findCropMarks(PDFLib, page, media) {
    const lines = collectLines(PDFLib, page);
    const tol = 0.15, minL = 2 * MM, maxL = 40 * MM;
    const V = [], H = [];
    for (const [[ax, ay], [bx, by]] of lines) {
      const dx = Math.abs(ax - bx), dy = Math.abs(ay - by);
      if (dx < tol && dy >= minL && dy <= maxL) V.push({ p: (ax + bx) / 2, a: Math.min(ay, by), b: Math.max(ay, by) });
      else if (dy < tol && dx >= minL && dx <= maxL) H.push({ p: (ay + by) / 2, a: Math.min(ax, bx), b: Math.max(ax, bx) });
    }
    // Candidate edges: positions with marks on both sides (above and below, or left and right).
    const cands = (L, lo, hi) => {
      const byPos = [];
      for (const l of L) {
        let g = byPos.find((q) => Math.abs(q.p - l.p) < tol);
        if (!g) byPos.push((g = { p: l.p, ls: [] }));
        g.ls.push(l);
      }
      return byPos.filter((g) => g.p > lo && g.p < hi && g.ls.length >= 2).slice(0, 60);
    };
    const xs = cands(V, media.x0, media.x1), ys = cands(H, media.y0, media.y1);
    // Marks at an edge: one beyond `lo` (ends before it) and one beyond `hi`.
    const ends = (g, lo, hi) => (g.ls.some((l) => l.b <= lo + tol) ? 1 : 0) + (g.ls.some((l) => l.a >= hi - tol) ? 1 : 0);
    let best = null;
    for (let i = 0; i < xs.length; i++) for (let i2 = 0; i2 < xs.length; i2++) {
      const L = xs[i], R = xs[i2];
      if (R.p - L.p < 10 * MM) continue;
      for (let j = 0; j < ys.length; j++) for (let j2 = 0; j2 < ys.length; j2++) {
        const B = ys[j], T = ys[j2];
        if (T.p - B.p < 10 * MM) continue;
        const score = ends(L, B.p, T.p) + ends(R, B.p, T.p) + ends(B, L.p, R.p) + ends(T, L.p, R.p);
        if (score < 7) continue;
        const area = (R.p - L.p) * (T.p - B.p);
        // Prefer complete sets, then the innermost (trim marks sit inside any bleed marks).
        if (!best || score > best.score || (score === best.score && area < best.area))
          best = { score, area, x0: L.p, x1: R.p, y0: B.p, y1: T.p };
      }
    }
    return best;
  }

  // ---------- main ----------

  // Plain-English checks on the numbers, so a bad value fails loudly instead of
  // silently cutting the artwork or producing a broken page.
  function validateOpts(opts, kind) {
    const bad = (m) => { throw new Error(m); };
    const num = (v) => typeof v === 'number' && Number.isFinite(v);
    if (!num(opts.bleedMm) || opts.bleedMm < 0 || opts.bleedMm > 50) bad('Bleed must be a number from 0 to 50 mm.');
    if (opts.mode === 'stretch' && !(num(opts.sliverMm) && opts.sliverMm > 0)) bad('Edge sliver must be more than 0 mm.');
    if (opts.marks) {
      if (!(num(opts.markLenMm) && opts.markLenMm > 0)) bad('Mark length must be more than 0 mm.');
      if (!(num(opts.markWeightPt) && opts.markWeightPt > 0)) bad('Line weight must be more than 0 pt.');
      if (!(num(opts.markOffsetMm) && opts.markOffsetMm >= 0)) bad('Offset from trim must be 0 mm or more.');
    }
    if (kind !== 'pdf' && !(num(opts.imageDpi) && opts.imageDpi > 0)) bad('Image dpi must be more than 0.');
    const given = (v) => v !== undefined && v !== null;
    if (given(opts.trimWMm) || given(opts.trimHMm)) {
      if (!(given(opts.trimWMm) && given(opts.trimHMm))) bad('Set both the trim width and height, or neither.');
      if (!(num(opts.trimWMm) && opts.trimWMm > 0 && num(opts.trimHMm) && opts.trimHMm > 0))
        bad('Trim width and height must both be more than 0 mm.');
    }
  }

  /**
   * opts: { bleedMm, mode: 'mirror'|'stretch', sliverMm, marks, markOffsetMm,
   *         markLenMm, markWeightPt, imageDpi, useFileDpi, hideSeams,
   *         trimWMm, trimHMm (both > 0 = manual trim size, centred) }
   * kind: 'pdf' | 'png' | 'jpg'
   * Returns { bytes, pages: [{wMm, hMm}], warnings: [string] }
   */
  async function addBleed(PDFLib, srcBytes, kind, opts) {
    validateOpts(opts, kind);
    const {
      PDFDocument, PDFName, PDFNumber, PDFArray, PDFDict, PDFPageLeaf, PDFPageEmbedder,
      PDFObjectCopier, PDFOperator, pushGraphicsState, popGraphicsState, rectangle, clip,
      endPath, concatTransformationMatrix, drawObject, setLineWidth, moveTo, lineTo, stroke,
    } = PDFLib;
    const N = (s) => PDFName.of(s);

    const b = opts.bleedMm * MM;
    const marks = opts.marks;
    const markOff = opts.markOffsetMm * MM;
    const markLen = opts.markLenMm * MM;
    const margin = marks ? Math.max(b, markOff + markLen) + 2 * MM : b;
    const warnings = [];
    const warn = (w) => { if (!warnings.includes(w)) warnings.push(w); };
    if (opts.bleedMm === 0) warn('No bleed added (bleed is 0 mm).');
    const custom = opts.trimWMm > 0 && opts.trimHMm > 0 ? { w: opts.trimWMm * MM, h: opts.trimHMm * MM } : null;

    const out = await PDFDocument.create({ updateMetadata: false });
    const ctx = out.context;

    // Sources: { ref (XObject or null for blank), base matrix, W, H, group }
    const sources = [];

    if (kind === 'pdf') {
      let src;
      try {
        src = await PDFDocument.load(srcBytes, { ignoreEncryption: true, throwOnInvalidObject: true, updateMetadata: false });
      } catch (e) {
        throw new Error('PDF is damaged or non-standard (' + e.message + '). Re-save it from Acrobat and try again.');
      }
      if (src.isEncrypted) {
        throw new Error('PDF has security / a password. Remove it in Acrobat (File > Properties > Security > No Security), save, and try again.');
      }

      // One copier for the whole job so shared objects (layers, fonts) stay shared.
      const copier = PDFObjectCopier.for(src.context, ctx);

      // Document-level things that affect how the artwork prints.
      for (const key of ['OCProperties', 'OutputIntents', 'Metadata']) {
        const v = src.catalog.get(N(key));
        if (v) out.catalog.set(N(key), copier.copy(v));
      }
      const srcInfo = src.context.lookup(src.context.trailerInfo.Info);
      if (srcInfo instanceof PDFDict) ctx.trailerInfo.Info = ctx.register(copier.copy(srcInfo));

      // Layer report.
      const ocp = src.catalog.lookupMaybe(N('OCProperties'), PDFDict);
      if (ocp) {
        const ocgs = ocp.lookupMaybe(N('OCGs'), PDFArray);
        const d = ocp.lookupMaybe(N('D'), PDFDict);
        const off = d && d.lookupMaybe(N('OFF'), PDFArray);
        const names = (arr) => (arr ? arr.asArray().map((r) => {
          const g = src.context.lookup(r);
          const n = g && g.lookup ? g.lookup(N('Name')) : null;
          return n ? n.decodeText ? n.decodeText() : String(n) : '?';
        }) : []);
        const hidden = names(off);
        warn(`Has ${ocgs ? ocgs.size() : 0} layer(s); visibility kept as in the original` +
          (hidden.length ? ` (hidden: ${hidden.join(', ')})` : '') + '.');
      }

      const pages = src.getPages();
      pages.forEach((p, idx) => {
        const pn = pages.length > 1 ? `Page ${idx + 1}: ` : '';
        const node = p.node;

        const uu = node.lookupMaybe(N('UserUnit'), PDFNumber);
        if (uu && uu.asNumber() !== 1) throw new Error(`${pn}uses UserUnit scaling, which isn't supported.`);

        // Annotations are not page content; report the ones that would print.
        const annots = node.lookupMaybe(N('Annots'), PDFArray);
        if (annots) {
          const kinds = new Set(); let count = 0;
          for (const r of annots.asArray()) {
            const a = src.context.lookup(r);
            if (!(a instanceof PDFDict)) continue;
            const st = a.lookup(N('Subtype')); const sub = st ? st.asString().slice(1) : '';
            const f = a.lookup(N('F')); const flags = f ? f.asNumber() : 0;
            if (sub === 'Link' || sub === 'Popup' || !(flags & 4) || (flags & 2)) continue;
            count++; kinds.add(sub === 'Widget' ? 'form field' : sub);
          }
          if (count) warn(`${pn}${count} printable annotation(s) (${[...kinds].join(', ')}) NOT included. ` +
            'Flatten them in Acrobat first if they should print.');
        }

        // Trim detection and sanity checks.
        const media = rect(p.getMediaBox());
        let box = rect(p.getTrimBox()); // TrimBox, else CropBox, else MediaBox
        const crop = rect(p.getCropBox());
        for (const [name, r] of [['MediaBox', media], ['CropBox', crop], ['TrimBox', box]]) {
          if (!(r.x1 - r.x0 >= 1 && r.y1 - r.y0 >= 1)) throw new Error(`Page ${idx + 1} has an empty ${name}`);
        }
        const same = (r, q) => ['x0', 'y0', 'x1', 'y1'].every((key) => Math.abs(r[key] - q[key]) < 0.3);
        // A TrimBox equal to the page is what many exports write when nobody set one.
        const hasTrim = !!node.get(N('TrimBox')) && !same(box, media);
        const rot = p.getRotation().angle || 0;
        const quarter = ((rot % 180) + 180) % 180 === 90;
        let found = null, tooBig = false;
        if (custom) {
          // Manual size, as seen on screen, centred on the page's trim/crop area.
          const [w, h] = quarter ? [custom.h, custom.w] : [custom.w, custom.h];
          const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
          box = { x0: cx - w / 2, x1: cx + w / 2, y0: cy - h / 2, y1: cy + h / 2 };
          warn(`${pn}trim set by hand to ${mm(custom.w)} × ${mm(custom.h)} mm, centred on the page.`);
          if (box.x0 < media.x0 - 0.3 || box.y0 < media.y0 - 0.3 || box.x1 > media.x1 + 0.3 || box.y1 > media.y1 + 0.3)
            { tooBig = true; warn(`${pn}the trim size set is bigger than the page; the edges will be blank.`); }
        } else if (!hasTrim) {
          try { found = findCropMarks(PDFLib, p, media); } catch (e) { found = null; }
          if (found) {
            box = found;
            warn(`${pn}no TrimBox; trim of ${mm(box.x1 - box.x0)} × ${mm(box.y1 - box.y0)} mm found from the crop marks on the page.`);
          }
        }
        const tw = box.x1 - box.x0, th = box.y1 - box.y0;
        if (custom || found) {
          // Nothing to add.
        } else if (!hasTrim) {
          const guess = looksLikeBleed(tw / MM, th / MM);
          warn(`${pn}no TrimBox or crop marks, so the page size (${mm(tw)} × ${mm(th)} mm) is used as the trim.` +
            (guess ? ` It looks like ${guess} already, so check it and set` : ' If that\'s wrong, set') + ' it under Trim size > Set size.');
        } else {
          const extra = Math.min(box.x0 - media.x0, box.y0 - media.y0, media.x1 - box.x1, media.y1 - box.y1);
          if (extra < -0.3) warn(`${pn}the TrimBox extends beyond the page; the edges will be blank.`);
          else if (extra > 0.3) warn(`${pn}already has ${mm(extra)} mm or more beyond the trim; it is replaced by the new bleed.`);
        }
        if (!tooBig && (crop.x0 > box.x0 + 0.3 || crop.y0 > box.y0 + 0.3 || crop.x1 < box.x1 - 0.3 || crop.y1 < box.y1 - 0.3))
          warn(`${pn}CropBox is smaller than the trim; artwork hidden by the crop will show.`);

        // Copy only the page content + resources (not annotations or the page tree).
        let ref = null;
        const contents = node.get(N('Contents'));
        if (contents) {
          const map = new Map();
          map.set(N('Contents'), copier.copy(contents));
          const res = node.getInheritableAttribute(N('Resources'));
          if (res) map.set(N('Resources'), copier.copy(res));
          const leaf = PDFPageLeaf.fromMapWithContext(map, ctx);
          const bbox = { left: media.x0, bottom: media.y0, right: media.x1, top: media.y1 };
          ref = ctx.nextRef();
          // Identity matrix so form space == source page space.
          sources.push({ pending: PDFPageEmbedder.for(leaf, bbox, [1, 0, 0, 1, 0, 0]), ref });
        } else {
          sources.push({ ref: null });
        }
        const s = sources[sources.length - 1];
        s.base = visualMatrix(box, rot);
        s.W = quarter ? th : tw;
        s.H = quarter ? tw : th;
        const group = node.get(N('Group'));
        if (group) s.group = copier.copy(group);
      });
      for (const s of sources) {
        if (s.pending) await (await s.pending).embedIntoContext(ctx, s.ref);
      }
    } else {
      const img = kind === 'png' ? await embedPng(srcBytes) : embedJpeg(srcBytes);
      let dpi = opts.imageDpi || 300, from = 'the dpi setting';
      if (opts.useFileDpi !== false && img.dpi) { dpi = img.dpi; from = 'the file'; }
      warn(`Image placed at ${Math.round(dpi)} dpi (from ${from}).`);
      const swap = img.orientation >= 5;
      const W = ((swap ? img.height : img.width) / dpi) * 72;
      const H = ((swap ? img.width : img.height) / dpi) * 72;
      if (img.orientation > 1) warn(`Rotated/flipped to match the camera orientation tag (EXIF ${img.orientation}).`);
      let base = orientMatrix(img.orientation, W, H), tw = W, th = H;
      if (custom) {
        // Manual trim: centred on the image (anything outside it is treated as existing bleed).
        tw = custom.w; th = custom.h;
        base = mul(base, [1, 0, 0, 1, (tw - W) / 2, (th - H) / 2]);
        warn(`Trim set by hand to ${mm(tw)} × ${mm(th)} mm, centred on the image.`);
        if (tw > W + 0.3 || th > H + 0.3) warn('The trim size set is bigger than the image; the edges will be blank.');
      }
      sources.push({ ref: img.ref, base, W: tw, H: th });
    }

    function iccStream(bytes, n, compressed) {
      const alt = n === 4 ? 'DeviceCMYK' : n === 1 ? 'DeviceGray' : 'DeviceRGB';
      const dict = { N: n, Alternate: alt };
      const s = compressed ? ctx.stream(bytes, { ...dict, Filter: 'FlateDecode' }) : ctx.flateStream(bytes, dict);
      return ctx.obj([N('ICCBased'), ctx.register(s)]);
    }

    // JPEG: the compressed data goes in unchanged.
    function embedJpeg(bytes) {
      const j = parseJpeg(bytes);
      const dev = j.comps === 4 ? 'DeviceCMYK' : j.comps === 1 ? 'DeviceGray' : 'DeviceRGB';
      const dict = {
        Type: 'XObject', Subtype: 'Image', Width: j.width, Height: j.height,
        BitsPerComponent: j.bpc || 8, Filter: 'DCTDecode',
        ColorSpace: j.iccBytes ? iccStream(j.iccBytes, j.comps, false) : dev,
      };
      // Photoshop-style CMYK JPEGs (Adobe marker) store inverted values.
      if (j.comps === 4 && j.adobe) dict.Decode = [1, 0, 1, 0, 1, 0, 1, 0];
      if (!j.iccBytes && j.comps !== 1) warn('Image has no embedded colour profile.');
      return { ref: ctx.register(ctx.stream(bytes, dict)), width: j.width, height: j.height, dpi: j.dpi, orientation: j.orientation };
    }

    // PNG: pass the compressed pixels straight through (lossless, keeps grey / 16-bit / indexed).
    // Only images with transparency or interlacing need decoding, via pdf-lib.
    async function embedPng(bytes) {
      const p = parsePng(bytes);
      const hasAlpha = p.colorType === 4 || p.colorType === 6 || p.trns;
      if (!hasAlpha && !p.interlace && [0, 2, 3].includes(p.colorType)) {
        const colors = p.colorType === 2 ? 3 : 1;
        const n = p.colorType === 0 ? 1 : 3;
        let cs = p.iccZ ? iccStream(p.iccZ, n, true) : (n === 1 ? N('DeviceGray') : N('DeviceRGB'));
        if (p.colorType === 3) {
          cs = ctx.obj([N('Indexed'), cs, p.plte.length / 3 - 1, PDFLib.PDFHexString.of(
            Array.from(p.plte, (x) => x.toString(16).padStart(2, '0')).join(''))]);
        }
        const dict = {
          Type: 'XObject', Subtype: 'Image', Width: p.width, Height: p.height,
          BitsPerComponent: p.bitDepth, ColorSpace: cs, Filter: 'FlateDecode',
          DecodeParms: { Predictor: 15, Colors: colors, BitsPerComponent: p.bitDepth, Columns: p.width },
        };
        if (!p.iccZ && n !== 1) warn('Image has no embedded colour profile.');
        return { ref: ctx.register(ctx.stream(concat(p.idat), dict)), width: p.width, height: p.height, dpi: p.dpi, orientation: 1 };
      }
      // Fallback: pdf-lib decodes to 8-bit RGB + alpha mask.
      const img = await out.embedPng(bytes);
      await img.embed();
      if (p.bitDepth === 16) warn('16-bit PNG with transparency was reduced to 8-bit.');
      if (p.colorType === 0 || p.colorType === 4) warn('Greyscale PNG with transparency was converted to RGB (will print 4-colour).');
      if (p.interlace) warn('Interlaced PNG was decoded and re-compressed (pixels unchanged).');
      if (p.iccZ && p.colorType !== 0 && p.colorType !== 4) {
        ctx.lookup(img.ref).dict.set(N('ColorSpace'), iccStream(p.iccZ, 3, true));
      } else if (!p.iccZ) warn('Image has no embedded colour profile.');
      return { ref: img.ref, width: p.width, height: p.height, dpi: p.dpi, orientation: 1 };
    }

    // Registration colour: a Separation named All prints on every plate, spot plates included.
    let regCS = null;
    if (marks) {
      const fn = ctx.register(ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [1, 1, 1, 1], N: 1 }));
      regCS = ctx.register(ctx.obj([N('Separation'), N('All'), N('DeviceCMYK'), fn]));
    }

    const info = [];
    for (const s of sources) {
      const { W, H } = s;
      const page = out.addPage([W + 2 * margin, H + 2 * margin]);
      if (s.group) page.node.set(N('Group'), s.group);
      const ox = margin, oy = margin;

      if (s.ref) {
        const name = page.node.newXObject('Art', s.ref);
        // Bleed scale: mirror = 1:1 reflection; stretch = sliver scaled out to bleed width.
        const sliver = Math.max(0.01, (opts.sliverMm || 0.5) * MM);
        const k = opts.mode === 'stretch' ? b / sliver : 1;

        // Seams: any AA renderer draws a faint line where two separately clipped
        // pieces meet, tinted by whatever objects are stacked under the edge.
        // To hide it, the untouched artwork goes down first, then each bleed piece
        // is painted over it as a transparency group: the group is rendered as one
        // flat image and only then clipped, and its own artwork edges sit beyond
        // the clip, so the clip edge lands on solid content. Pieces reach SEAM pt
        // past their edge (side strips over the trim edge, corners over the sides),
        // so the outer SEAM pt of the trim shows the mirrored edge instead of the
        // original. With hideSeams off, every piece is clipped exactly instead.
        const hide = opts.hideSeams !== false;
        const ov = hide ? SEAM : 0, g = 2 * ov;
        const pw = W + 2 * margin, ph = H + 2 * margin;
        const span = (side, o, len, ext) => (side < 0 ? [o - b, b + ext] : side > 0 ? [o + len - ext, b + ext] : [o, len]);
        const cells = [[0, 0]];
        for (const j of [-1, 0, 1]) for (const i of [-1, 0, 1]) if (!i !== !j) cells.push([i, j]);
        for (const j of [-1, 1]) for (const i of [-1, 1]) cells.push([i, j]);
        for (const [i, j] of cells) {
          if (b <= 0 && (i || j)) continue;
          const [sx, ex] = axis(i, ox, W, k, i ? g : 0);
          const [sy, ey] = axis(j, oy, H, k, j ? g : 0);
          const m = mul(s.base, [sx, 0, 0, sy, ex, ey]);
          const [cx, cw] = span(i, ox, W, i ? ov : 0);
          const [cy, ch] = span(j, oy, H, j ? ov : 0);
          let xo = name, pre = [concatTransformationMatrix(...m)];
          if (hide && (i || j)) {
            const grp = ctx.register(ctx.flateStream(`${m.map((v) => +v.toFixed(6)).join(' ')} cm /Art Do`, {
              Type: 'XObject', Subtype: 'Form', BBox: [0, 0, pw, ph],
              Group: { S: 'Transparency' }, Resources: { XObject: { Art: s.ref } },
            }));
            xo = page.node.newXObject('Bleed', grp);
            pre = [];
          }
          page.pushOperators(
            pushGraphicsState(),
            rectangle(cx, cy, cw, ch), clip(), endPath(),
            ...pre,
            drawObject(xo),
            popGraphicsState(),
          );
        }
      }

      if (marks) {
        const csName = addColorSpace(page.node, regCS);
        const ops = [pushGraphicsState(), PDFOperator.of('CS', [csName]), PDFOperator.of('SCN', [PDFNumber.of(1)]),
          setLineWidth(opts.markWeightPt || 0.25)];
        const line = (x1, y1, x2, y2) => ops.push(moveTo(x1, y1), lineTo(x2, y2), stroke());
        for (const x of [ox, ox + W]) {
          line(x, oy - markOff, x, oy - markOff - markLen);
          line(x, oy + H + markOff, x, oy + H + markOff + markLen);
        }
        for (const y of [oy, oy + H]) {
          line(ox - markOff, y, ox - markOff - markLen, y);
          line(ox + W + markOff, y, ox + W + markOff + markLen, y);
        }
        ops.push(popGraphicsState());
        page.pushOperators(...ops);
      }

      page.setTrimBox(ox, oy, W, H);
      page.setBleedBox(ox - b, oy - b, W + 2 * b, H + 2 * b);
      info.push({ wMm: W / MM, hMm: H / MM });
    }

    function addColorSpace(node, ref) {
      const { Resources } = node.normalizedEntries();
      let cs = Resources.lookupMaybe(N('ColorSpace'), PDFDict);
      if (!cs) { cs = ctx.obj({}); Resources.set(N('ColorSpace'), cs); }
      cs.set(N('Reg'), ref);
      return N('Reg');
    }

    return { bytes: await out.save(), pages: info, warnings };
  }

  const api = { addBleed, validateOpts, MM, parseJpeg, parsePng, findCropMarks };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AddBleed = api;
})(typeof self !== 'undefined' ? self : this);
