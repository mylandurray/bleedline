// Core: add mirrored/stretched bleed and trim marks to a PDF or image.
// Works in the browser (PDFLib global) and in Node (pass the pdf-lib module).
// Everything stays vector: the original page is copied once as a Form XObject
// and redrawn flipped/stretched into each bleed strip, clipped to that strip.
// With keepBleed, a PDF page whose TrimBox already has enough artwork around it
// is drawn once, clipped to trim + bleed, instead.
// PDF page content, fonts and images are copied unchanged (byte-for-byte for
// single-stream pages; multi-part page content is joined and recompressed
// losslessly). JPEG data is embedded as is; PNG data is passed through where
// possible and otherwise re-compressed losslessly.

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
  function axis(side, o, len, k) {
    if (side === 0) return [1, o];
    if (side < 0) return [-k, o];
    return [-k, o + len + k * len];
  }

  // Images with no resolution saved are placed at 72 dpi, as Photoshop and Acrobat do.
  const DEFAULT_DPI = 72;

  // PDF boxes may list their corners in any order, so normalise to min/max.
  const rect = (r) => ({
    x0: Math.min(r.x, r.x + r.width), x1: Math.max(r.x, r.x + r.width),
    y0: Math.min(r.y, r.y + r.height), y1: Math.max(r.y, r.y + r.height),
  });
  const mm = (pt) => (pt / MM).toFixed(1);
  const cap = (t) => t[0].toUpperCase() + t.slice(1);

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
        r.sof = m; r.bpc = d[s]; r.height = u16(d, s + 1); r.width = u16(d, s + 3); r.comps = d[s + 5];
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

  // Every visible, axis-aligned stroked line (and hairline-thin filled rect) in page space:
  // { v: vertical?, p: x (vertical) or y, a..b: extent along the line, w: stroke width in pt }.
  // Returns { lines } or { error: 'complex' | 'unreadable' }; on error the caller must not
  // guess a trim, because lines it didn't see could change the answer.
  function collectLines(PDFLib, page) {
    const { PDFName, PDFDict, PDFArray, PDFNumber, PDFRawStream, decodePDFRawStream } = PDFLib;
    const N = (s) => PDFName.of(s);
    const ctx = page.doc.context;
    const lines = [];
    let budget = 400000; // operators; bail out on huge artwork
    let error = null;
    const bytesOf = (s) => (s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents());
    const nameOf = (o) => (o instanceof PDFName ? o.asString() : '');

    // Optional content (layers): what the default configuration hides.
    const ocp = page.doc.catalog.lookupMaybe(N('OCProperties'), PDFDict);
    const cfg = ocp && ocp.lookupMaybe(N('D'), PDFDict);
    const groupSet = (k) => {
      const arr = cfg && cfg.lookupMaybe(N(k), PDFArray);
      return new Set(arr ? arr.asArray().map((r) => ctx.lookup(r)) : []);
    };
    const offSet = groupSet('OFF'), onSet = groupSet('ON');
    const baseOff = !!cfg && nameOf(cfg.lookup(N('BaseState'))) === '/OFF';
    const ocgOn = (g) => (baseOff ? onSet.has(g) : !offSet.has(g));
    function evalVE(arr, depth) { // visibility expression: [/And|/Or|/Not ...]
      if (depth > 10) return null;
      const items = arr.asArray(), op = nameOf(items[0]);
      const vals = [];
      for (const it of items.slice(1)) {
        const o = ctx.lookup(it);
        if (o instanceof PDFArray) { const r = evalVE(o, depth + 1); if (r === null) return null; vals.push(r); }
        else if (o instanceof PDFDict) vals.push(ocgOn(o));
      }
      if (op === '/And') return vals.every(Boolean);
      if (op === '/Or') return vals.some(Boolean);
      if (op === '/Not') return vals.length ? !vals[0] : null;
      return null;
    }
    // Is an OCG / OCMD visible? Anything we can't read counts as visible.
    function visible(o) {
      if (!ocp || !(o instanceof PDFDict)) return true;
      const t = nameOf(o.lookup(N('Type')));
      if (t === '/OCG') return ocgOn(o);
      if (t !== '/OCMD') return true;
      const ve = o.lookup(N('VE'));
      if (ve instanceof PDFArray) { const r = evalVE(ve, 0); if (r !== null) return r; }
      const g = o.lookup(N('OCGs'));
      const groups = g instanceof PDFArray ? g.asArray().map((r) => ctx.lookup(r)) : [g];
      const on = groups.filter((x) => x instanceof PDFDict).map(ocgOn);
      if (!on.length) return true;
      switch (nameOf(o.lookup(N('P')))) {
        case '/AllOn': return on.every(Boolean);
        case '/AnyOff': return on.some((x) => !x);
        case '/AllOff': return on.every((x) => !x);
        default: return on.some(Boolean); // /AnyOn
      }
    }

    // Record a segment if it's axis-aligned, clipped to the enclosing form BBoxes.
    function add(p, q, w, clip) {
      const dx = Math.abs(p[0] - q[0]), dy = Math.abs(p[1] - q[1]);
      if (Math.max(dx, dy) < 0.15) return;
      let l;
      if (dx < 0.15) l = { v: true, p: (p[0] + q[0]) / 2, a: Math.min(p[1], q[1]), b: Math.max(p[1], q[1]), w };
      else if (dy < 0.15) l = { v: false, p: (p[1] + q[1]) / 2, a: Math.min(p[0], q[0]), b: Math.max(p[0], q[0]), w };
      else return;
      if (clip) {
        const [plo, phi, lo, hi] = l.v ? [clip.x0, clip.x1, clip.y0, clip.y1] : [clip.y0, clip.y1, clip.x0, clip.x1];
        if (l.p < plo - 0.5 || l.p > phi + 0.5) return;
        l.a = Math.max(l.a, lo); l.b = Math.min(l.b, hi);
        if (l.b - l.a < 0.15) return;
      }
      lines.push(l);
    }

    function run(datas, res, ctm, depth, hiddenIn, clip) {
      const stack = [];
      const mc = []; // marked-content stack: true = hidden layer
      let lw = 1, hidden = hiddenIn;
      let path = [], cur = null, start = null;
      const pt = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
      const seg = (a, c) => path.push([a, c]);
      const num = (v) => typeof v === 'number' && Number.isFinite(v);
      for (const data of datas) {
        for (const [op, a] of tokens(data)) {
          if (--budget < 0) { error = 'complex'; return; }
          switch (op) {
            case 'q': stack.push([ctm, lw]); break;
            case 'Q': if (stack.length) [ctm, lw] = stack.pop(); break;
            case 'cm': if (a.length === 6 && a.every(num)) ctm = mul(a, ctm); break;
            case 'w': if (num(a[0])) lw = Math.abs(a[0]); break;
            case 'gs': {
              const eg = res && res.lookupMaybe(N('ExtGState'), PDFDict);
              const g = eg && typeof a[0] === 'string' ? eg.lookup(N(a[0])) : null;
              const v = g instanceof PDFDict ? g.lookup(N('LW')) : null;
              if (v instanceof PDFNumber) lw = Math.abs(v.asNumber());
              break;
            }
            case 'BMC': mc.push(false); break;
            case 'BDC': {
              let h = false;
              if (a[0] === 'OC' && typeof a[1] === 'string') {
                const props = res && res.lookupMaybe(N('Properties'), PDFDict);
                h = !visible(props ? props.lookup(N(a[1])) : null);
              }
              mc.push(h); hidden = hiddenIn || mc.includes(true);
              break;
            }
            case 'EMC': mc.pop(); hidden = hiddenIn || mc.includes(true); break;
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
              // Stroke width in page space (the CTM at paint time scales it).
              const width = lw * Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]));
              if (!hidden) {
                for (const p of path) {
                  if (p.rect) {
                    if (stroked) { for (let k = 0; k < 4; k++) add(p.rect[k], p.rect[(k + 1) % 4], width, clip); continue; }
                    if (!filled) continue;
                    // A thin filled rectangle is drawn the same as a line.
                    const xs = p.rect.map((q) => q[0]), ys = p.rect.map((q) => q[1]);
                    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
                    if (x1 - x0 < 1.5 && y1 - y0 > 2) add([(x0 + x1) / 2, y0], [(x0 + x1) / 2, y1], x1 - x0, clip);
                    else if (y1 - y0 < 1.5 && x1 - x0 > 2) add([x0, (y0 + y1) / 2], [x1, (y0 + y1) / 2], y1 - y0, clip);
                  } else if (stroked) add(p[0], p[1], width, clip);
                }
              }
              path = []; cur = start = null;
              break;
            }
            case 'Do': {
              if (!res || typeof a[0] !== 'string') break;
              const xd = res.lookupMaybe(N('XObject'), PDFDict);
              const x = xd && xd.lookup(N(a[0]));
              if (!x || !x.dict) break;
              if (nameOf(x.dict.lookup(N('Subtype'))) !== '/Form') break;
              if (depth > 6) { error = 'unreadable'; return; } // too deep, or a form that draws itself
              if (!visible(x.dict.lookup(N('OC')))) break; // form on a hidden layer
              const fm = x.dict.lookupMaybe(N('Matrix'), PDFArray);
              const m = fm ? fm.asArray().map((v) => v.asNumber()) : [1, 0, 0, 1, 0, 0];
              const fctm = mul(m, ctm);
              // The form's BBox clips everything it draws.
              let fclip = clip;
              const bb = x.dict.lookupMaybe(N('BBox'), PDFArray);
              if (bb && bb.size() === 4) {
                const [bx0, by0, bx1, by1] = bb.asArray().map((v) => v.asNumber());
                const t = (u, w) => [fctm[0] * u + fctm[2] * w + fctm[4], fctm[1] * u + fctm[3] * w + fctm[5]];
                const cs = [t(bx0, by0), t(bx1, by0), t(bx1, by1), t(bx0, by1)];
                const r = {
                  x0: Math.min(...cs.map((c) => c[0])), x1: Math.max(...cs.map((c) => c[0])),
                  y0: Math.min(...cs.map((c) => c[1])), y1: Math.max(...cs.map((c) => c[1])),
                };
                fclip = clip ? { x0: Math.max(r.x0, clip.x0), x1: Math.min(r.x1, clip.x1), y0: Math.max(r.y0, clip.y0), y1: Math.min(r.y1, clip.y1) } : r;
                if (fclip.x1 <= fclip.x0 || fclip.y1 <= fclip.y0) break; // nothing visible
              }
              let data; try { data = bytesOf(x); } catch (e) { error = 'unreadable'; return; }
              run([data], x.dict.lookupMaybe(N('Resources'), PDFDict) || res, fctm, depth + 1, hidden, fclip);
              if (error) return;
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
    for (const s of streams) { try { datas.push(bytesOf(s)); } catch (e) { return { error: 'unreadable' }; } }
    const res = ctx.lookup(page.node.getInheritableAttribute(N('Resources')));
    run(datas, res instanceof PDFDict ? res : null, [1, 0, 0, 1, 0, 0], 0, false, null);
    return error ? { error } : { lines };
  }

  // Look for printer's crop marks: short lines that extend the trim edges out into the
  // margin at each corner. Returns { x0, y0, x1, y1, score } in page space (score = marks
  // found, 7 or 8), or null. A false trim crops the artwork, so anything doubtful is null;
  // `diag.reason` is then 'complex', 'unreadable' or 'ambiguous' when that's why.
  function findCropMarks(PDFLib, page, media, diag = {}) {
    const got = collectLines(PDFLib, page);
    if (got.error) { diag.reason = got.error; return null; }
    const all = got.lines;
    const tol = 0.15, minL = 2 * MM, maxL = 40 * MM, reach = 25 * MM, maxW = 1.5, edgeTol = 0.5;
    const conc = 0.5 * MM;
    // Mark-like: 2-40 mm long and no heavier than 1.5 pt (rule 5).
    const V = [], H = [];
    for (const l of all) if (l.b - l.a >= minL && l.b - l.a <= maxL && l.w <= maxW) (l.v ? V : H).push(l);
    const marky = V.concat(H);
    // All lines (any length or weight) by position, for the "trim edge drawn" check.
    const byP = (L) => L.slice().sort((p, q) => p.p - q.p);
    const allV = byP(all.filter((l) => l.v)), allH = byP(all.filter((l) => !l.v));

    // Candidate edges: positions with at least one mark-like line.
    const groups = (L, lo, hi) => {
      const gs = [];
      for (const l of byP(L)) {
        const g = gs[gs.length - 1];
        if (g && Math.abs(l.p - g.p) < tol) g.ls.push(l); else gs.push({ p: l.p, ls: [l] });
      }
      return gs.filter((g) => g.p > lo && g.p < hi);
    };
    const W = media.x1 - media.x0, Hh = media.y1 - media.y0;
    const mcx = (media.x0 + media.x1) / 2, mcy = (media.y0 + media.y1) / 2;
    const xs = groups(V, media.x0, media.x1), ys = groups(H, media.y0, media.y1);
    // Pairs that could pass rule 4: at least half the page across, centred within 10%.
    const pairs = (gs, size, mid) => {
      const out = [];
      for (let i = 0; i < gs.length; i++) for (let k = i + 1; k < gs.length; k++) {
        const lo = gs[i], hi = gs[k];
        if (hi.p - lo.p >= 0.5 * size && Math.abs((lo.p + hi.p) / 2 - mid) <= 0.1 * size) out.push([lo, hi]);
      }
      return out;
    };
    const xp = pairs(xs, W, mcx), yp = pairs(ys, Hh, mcy);
    if (xp.length * yp.length > 2e6) { diag.reason = 'complex'; return null; }

    // Rule 1: the marks along one edge line, one beyond each end of the trim edge, lying wholly
    // outside the trim with the near end within 25 mm of the corner.
    // Binary search: first index in `arr` (sorted by key) whose key is >= v.
    const lower = (arr, key, v) => {
      let lo = 0, hi = arr.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid][key] < v) lo = mid + 1; else hi = mid; }
      return lo;
    };
    for (const g of xs.concat(ys)) {
      g.byB = g.ls.slice().sort((p, q) => p.b - q.b);
      g.byA = g.ls.slice().sort((p, q) => p.a - q.a);
    }
    const pick = (g, lo, hi) => {
      const i = lower(g.byB, 'b', lo + tol + 1e-9) - 1; // last line ending at or before the corner
      const before = i >= 0 && g.byB[i].b >= lo - reach ? g.byB[i] : null;
      const k = lower(g.byA, 'a', hi - tol); // first line starting at or after the other corner
      const after = k < g.byA.length && g.byA[k].a <= hi + reach ? g.byA[k] : null;
      return [before, after];
    };
    // Rule 2: total length of lines drawn along an edge, between its corners.
    const drawn = (sorted, p, lo, hi) => {
      const iv = [];
      for (let i = lower(sorted, 'p', p - edgeTol); i < sorted.length; i++) {
        const l = sorted[i];
        if (l.p > p + edgeTol) break;
        const a = Math.max(l.a, lo), b = Math.min(l.b, hi);
        if (b > a) iv.push([a, b]);
      }
      iv.sort((u, w) => u[0] - w[0]);
      let sum = 0, end = -Infinity;
      for (const [a, b] of iv) { if (b > end) { sum += b - Math.max(a, end); end = b; } }
      return sum;
    };
    const inOpen = (v, lo, hi) => v > lo + tol && v < hi - tol;
    const outside = (v, lo, hi) => v < lo - tol || v > hi + tol;
    // Rule 3: a mark-like line that starts outside the rectangle and ends inside it.
    const crossesIn = (c) => marky.some((l) => {
      const [plo, phi, lo, hi] = l.v ? [c.x0, c.x1, c.y0, c.y1] : [c.y0, c.y1, c.x0, c.x1];
      if (!inOpen(l.p, plo, phi)) return false;
      return (inOpen(l.a, lo, hi) && outside(l.b, lo, hi)) || (inOpen(l.b, lo, hi) && outside(l.a, lo, hi));
    });
    const wholly = (l, c) => { // line lies entirely outside rectangle c
      const [plo, phi, lo, hi] = l.v ? [c.x0, c.x1, c.y0, c.y1] : [c.y0, c.y1, c.x0, c.x1];
      return l.p <= plo + tol || l.p >= phi - tol || l.b <= lo + tol || l.a >= hi - tol;
    };

    const cands = [];
    for (const [L, R] of xp) for (const [B, T] of yp) {
      const c = { x0: L.p, x1: R.p, y0: B.p, y1: T.p };
      const used = [...pick(L, c.y0, c.y1), ...pick(R, c.y0, c.y1), ...pick(B, c.x0, c.x1), ...pick(T, c.x0, c.x1)].filter(Boolean);
      if (used.length < 7) continue;
      const area = (c.x1 - c.x0) * (c.y1 - c.y0);
      const ok = area >= 0.5 * W * Hh &&
        drawn(allH, c.y0, c.x0, c.x1) <= 2 * MM && drawn(allH, c.y1, c.x0, c.x1) <= 2 * MM &&
        drawn(allV, c.x0, c.y0, c.y1) <= 2 * MM && drawn(allV, c.x1, c.y0, c.y1) <= 2 * MM &&
        !crossesIn(c);
      cands.push({ c, score: used.length, used, ok });
    }

    const valid = cands.filter((e) => e.ok);
    if (!valid.length) return null;
    const top = Math.max(...valid.map((e) => e.score));
    const tops = valid.filter((e) => e.score === top);
    const contains = (o, i) => o.x0 <= i.x0 + tol && o.y0 <= i.y0 + tol && o.x1 >= i.x1 - tol && o.y1 >= i.y1 - tol;
    const same = (p, q) => ['x0', 'y0', 'x1', 'y1'].every((k) => Math.abs(p[k] - q[k]) <= tol);
    const centred = (p, q) => Math.abs(p.x0 + p.x1 - q.x0 - q.x1) / 2 <= conc && Math.abs(p.y0 + p.y1 - q.y0 - q.y1) / 2 <= conc;
    // Several valid sets are only fine when they are trim plus bleed marks: one rectangle inside
    // all the others, the outermost one is itself a valid set, and they share a centre. Mixed
    // sets (some edges from each) fall between the two, so they don't change the answer.
    const inner = tops.find((e) => tops.every((o) => contains(o.c, e.c)));
    const outer = tops.find((e) => tops.every((o) => contains(e.c, o.c)));
    if (!inner || !outer || !centred(inner.c, outer.c)) { diag.reason = 'ambiguous'; return null; }
    // A rejected or less complete concentric set inside the chosen one, with its marks out in the
    // margin, is probably the real trim (e.g. 7 of 8 trim marks inside complete bleed marks).
    for (const e of cands) {
      if (e === inner || same(e.c, inner.c) || !contains(inner.c, e.c) || !centred(e.c, inner.c)) continue;
      if (e.used.every((l) => wholly(l, inner.c))) { diag.reason = 'ambiguous'; return null; }
    }
    const { x0, y0, x1, y1 } = inner.c;
    return { x0, y0, x1, y1, score: top };
  }

  // ---------- PDF/X, PDF/A and file identity ----------

  // The document's XMP packet: null if there is none, { text: null } if it isn't readable UTF-8.
  function readXmp(PDFLib, doc) {
    const { PDFName, PDFRawStream, decodePDFRawStream } = PDFLib;
    const s = doc.catalog.lookup(PDFName.of('Metadata'));
    if (!(s instanceof PDFRawStream)) return null;
    try {
      const bytes = s.dict.get(PDFName.of('Filter')) ? decodePDFRawStream(s).decode() : s.getContents();
      return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
    } catch (e) {
      return { text: null };
    }
  }

  // Value of an XMP property written as an element or an attribute.
  function xmpField(xmp, name) {
    const m = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']|<${name}>([^<]*)</${name}>`).exec(xmp || '');
    return m ? (m[1] !== undefined ? m[1] : m[2]).trim() : null;
  }

  // Which standards the source claims, and its PDF version (the header, or the catalog
  // /Version when that is higher). { pdfx: '1a'|'3'|'4'|null, pdfa: number|null, version: 'M.m' }
  function standardsOf(PDFLib, src) {
    const { PDFName, PDFDict, PDFString, PDFHexString } = PDFLib;
    const N = (s) => PDFName.of(s);
    const xmp = (readXmp(PDFLib, src) || {}).text;
    const info = src.context.lookup(src.context.trailerInfo.Info);
    let x = null;
    if (info instanceof PDFDict) {
      const v = info.lookup(N('GTS_PDFXVersion'));
      if (v instanceof PDFString || v instanceof PDFHexString) x = v.decodeText();
    }
    x = x || xmpField(xmp, 'pdfxid:GTS_PDFXVersion') || xmpField(xmp, 'pdfx:GTS_PDFXVersion');
    const xn = x && /X-(\d)/i.exec(x);
    // X-1a and X-3 (and the older X-1 / X-2) forbid transparency and object streams; X-4 and
    // later allow both.
    const pdfx = !xn ? null : +xn[1] <= 1 ? '1a' : +xn[1] <= 3 ? '3' : '4';
    const part = parseInt(xmpField(xmp, 'pdfaid:part'), 10);
    const pdfa = part > 0 ? part : null;
    const h = src.context.header;
    let version = `${h.major}.${h.minor}`;
    const cv = src.catalog.get(N('Version'));
    const cvs = cv instanceof PDFName ? cv.decodeText() : '';
    if (/^\d\.\d$/.test(cvs) && +cvs > +version) version = cvs;
    return { pdfx, pdfa, version };
  }

  // Set the XMP properties in `values` ({ name: value }). Each one present must be a single
  // plain element or attribute; otherwise returns null so the caller leaves the XMP (and the
  // matching Info entries) alone. Also null when none of them is present.
  function editXmp(text, values) {
    let out = text, changed = [];
    for (const [name, v] of Object.entries(values)) {
      const mentions = (out.match(new RegExp(`${name}\\b`, 'g')) || []).length;
      if (!mentions) continue;
      const el = new RegExp(`(<${name}>)[^<]*(</${name}>)`, 'g');
      const at = new RegExp(`(\\s${name}\\s*=\\s*)(["'])[^"']*\\2`, 'g');
      const ne = (out.match(el) || []).length, na = (out.match(at) || []).length;
      if (ne + na !== 1 || 2 * ne + na !== mentions) return null;
      out = ne ? out.replace(el, `$1${v}$2`) : out.replace(at, `$1$2${v}$2`);
      changed.push(name);
    }
    return changed.length ? { text: out, changed } : null;
  }

  function randomBytes(n) {
    const c = typeof crypto !== 'undefined' ? crypto : require('node:crypto').webcrypto;
    return c.getRandomValues(new Uint8Array(n));
  }
  function randomUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    const b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  const toHex = (a) => Array.from(a, (x) => x.toString(16).padStart(2, '0')).join('');

  // ---------- size checks ----------

  const TOL = 0.5 * MM; // sizes within half a millimetre count as the same

  // Before: pages that are the same size as supplied must get the same trim, so one stray page
  // (odd crop marks, a different TrimBox) can't be cut to a completely different size.
  // Throws when they disagree; warns when the trim is much smaller than the artwork.
  function checkSizes(sources, warn) {
    const near = (a, b) => Math.abs(a - b) <= TOL;
    const sameArt = (a, b) => near(a.artW, b.artW) && near(a.artH, b.artH);
    const sameTrim = (a, b) => near(a.W, b.W) && near(a.H, b.H);
    const many = sources.length > 1;
    const pn = (i) => (many ? `Page ${i + 1}: ` : '');
    const size = (w, h) => `${mm(w)} × ${mm(h)} mm`;
    const done = new Set();
    sources.forEach((s, i) => {
      if (done.has(s)) return;
      const group = sources.filter((t) => sameArt(s, t));
      group.forEach((t) => done.add(t));
      if (group.length < 2) return;
      // The trim most of these pages agree on.
      const common = group.reduce((best, t) => {
        const n = group.filter((u) => sameTrim(t, u)).length;
        return n > best.n ? { t, n } : best;
      }, { t: null, n: 0 }).t;
      const odd = group.filter((t) => !sameTrim(t, common));
      if (!odd.length) return;
      const list = odd.map((t) => `page ${sources.indexOf(t) + 1} (${size(t.W, t.H)}, from ${t.from})`).join(', ');
      throw new Error(`Pages that are the same size (${size(s.artW, s.artH)}) would be trimmed to different sizes: ` +
        `most to ${size(common.W, common.H)} (from ${common.from}), but ${list}. Nothing was made. ` +
        'Check the file, or set the trim under Trim size > Custom.');
    });
    const froms = [...new Set(sources.map((s) => s.from))];
    if (froms.length > 1) warn(`The trim was found in different ways on different pages (${froms.join(', ')}); check each page.`);
    sources.forEach((s, i) => {
      if (s.W < 0.7 * s.artW - TOL || s.H < 0.7 * s.artH - TOL)
        warn(`${pn(i)}the trim (${size(s.W, s.H)}) is much smaller than the artwork (${size(s.artW, s.artH)}); check it's right.`);
    });
  }

  // After: read the finished PDF back and confirm every page has the trim and bleed it was meant to.
  async function checkOutput(PDFLib, bytes, sources, b) {
    const doc = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
    const pages = doc.getPages();
    const fail = (m) => { throw new Error(`Output check failed: ${m}. Nothing was made; please report this file.`); };
    if (pages.length !== sources.length) fail(`${pages.length} pages out, ${sources.length} in`);
    pages.forEach((p, i) => {
      const s = sources[i], t = rect(p.getTrimBox()), bl = rect(p.getBleedBox()), m = rect(p.getMediaBox());
      const near = (a, c) => Math.abs(a - c) < 0.01;
      if (!near(t.x1 - t.x0, s.W) || !near(t.y1 - t.y0, s.H)) fail(`page ${i + 1} trim is ${mm(t.x1 - t.x0)} × ${mm(t.y1 - t.y0)} mm, expected ${mm(s.W)} × ${mm(s.H)} mm`);
      if (!near(bl.x1 - bl.x0, s.W + 2 * b) || !near(bl.y1 - bl.y0, s.H + 2 * b)) fail(`page ${i + 1} bleed box is the wrong size`);
      if (bl.x0 < m.x0 - 0.01 || bl.y0 < m.y0 - 0.01 || bl.x1 > m.x1 + 0.01 || bl.y1 > m.y1 + 0.01) fail(`page ${i + 1} bleed is outside the page`);
    });
  }

  // ---------- main ----------

  // Plain-English checks on the numbers, so a bad value fails loudly instead of
  // silently cutting the artwork or producing a broken page.
  function validateOpts(opts, kind) {
    const bad = (m) => { throw new Error(m); };
    const num = (v) => typeof v === 'number' && Number.isFinite(v);
    if (!num(opts.bleedMm) || opts.bleedMm < 0 || opts.bleedMm > 50) bad('Bleed must be a number from 0 to 50 mm.');
    if (opts.mode === 'stretch' && !(num(opts.sliverMm) && opts.sliverMm > 0)) bad('Sliver must be more than 0 mm.');
    if (opts.marks) {
      if (!(num(opts.markLenMm) && opts.markLenMm > 0)) bad('Mark length must be more than 0 mm.');
      if (!(num(opts.markWeightPt) && opts.markWeightPt > 0)) bad('Line weight must be more than 0 pt.');
      if (!(num(opts.markOffsetMm) && opts.markOffsetMm >= 0)) bad('Offset from trim must be 0 mm or more.');
    }
    const given = (v) => v !== undefined && v !== null;
    if (given(opts.trimWMm) || given(opts.trimHMm)) {
      if (!(given(opts.trimWMm) && given(opts.trimHMm))) bad('Set both the trim width and height, or neither.');
      if (!(num(opts.trimWMm) && opts.trimWMm > 0 && num(opts.trimHMm) && opts.trimHMm > 0))
        bad('Trim width and height must both be more than 0 mm.');
    }
  }

  /**
   * opts: { bleedMm, mode: 'mirror'|'stretch', sliverMm, marks, markOffsetMm,
   *         markLenMm, markWeightPt,
   *         keepBleed (true = use the PDF's own bleed when its TrimBox has enough on all sides),
   *         trimWMm, trimHMm (both > 0 = manual trim size, centred) }
   * kind: 'pdf' | 'png' | 'jpg'
   * Returns { bytes, pages: [{wMm, hMm, srcTrim (PDF only: [x0,y0,x1,y1] in source page space)}], warnings: [string] }
   */
  async function addBleed(PDFLib, srcBytes, kind, opts) {
    validateOpts(opts, kind);
    const {
      PDFDocument, PDFName, PDFNumber, PDFArray, PDFDict, PDFRawStream, decodePDFRawStream,
      PDFString, PDFHexString, PDFHeader, PDFObjectCopier, PDFOperator, pushGraphicsState, popGraphicsState, rectangle, clip,
      endPath, concatTransformationMatrix, drawObject, setLineWidth, moveTo, lineTo, stroke,
    } = PDFLib;
    const N = (s) => PDFName.of(s);

    const b = opts.bleedMm * MM;
    const marks = opts.marks;
    // Marks may sit inside the bleed (they are trimmed off with it), never inside the trim.
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
    // PDF sources: claimed standards and version. Images: no claim, pdf-lib's default 1.7.
    let std = { pdfx: null, pdfa: null, version: null };
    let firstId = null; // the source's permanent ID, kept as the first half of the output's /ID

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

      std = standardsOf(PDFLib, src);
      const id = src.context.lookup(src.context.trailerInfo.ID);
      const id0 = id instanceof PDFArray && id.size() ? id.lookup(0) : null;
      if ((id0 instanceof PDFHexString || id0 instanceof PDFString) && id0.asBytes().length) firstId = id0.asBytes();

      // Document-level things that affect how the artwork prints.
      for (const key of ['OCProperties', 'OutputIntents']) {
        const v = src.catalog.get(N(key));
        if (v) out.catalog.set(N(key), copier.copy(v));
      }
      const srcInfo = src.context.lookup(src.context.trailerInfo.Info);
      const outInfo = srcInfo instanceof PDFDict ? copier.copy(srcInfo) : null;
      if (outInfo) ctx.trailerInfo.Info = ctx.register(outInfo);

      // XMP and Info: this is a new file, so it gets a new InstanceID and modification date.
      // Both are changed together or not at all, so they never disagree (PDF/A checks this).
      const meta = src.catalog.get(N('Metadata'));
      const now = new Date().toISOString().slice(0, 19); // UTC, YYYY-MM-DDTHH:mm:ss
      const xmp = meta ? readXmp(PDFLib, src) : null;
      const edited = xmp && xmp.text != null ? editXmp(xmp.text, {
        'xmpMM:InstanceID': 'uuid:' + randomUUID(),
        'xmp:MetadataDate': now + '+00:00',
        'xmp:ModifyDate': now + '+00:00',
      }) : null;
      if (edited) {
        // Unfiltered: PDF/A-1 doesn't allow filters on metadata.
        const s = ctx.stream(new TextEncoder().encode(edited.text), { Type: 'Metadata', Subtype: 'XML' });
        out.catalog.set(N('Metadata'), ctx.register(s));
      } else if (meta) {
        out.catalog.set(N('Metadata'), copier.copy(meta));
      }
      if (outInfo && (!meta || (edited && edited.changed.includes('xmp:ModifyDate')))) {
        outInfo.set(N('ModDate'), PDFString.of(`D:${now.replace(/[-T:]/g, '')}+00'00'`));
      }

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
        const rawTrim = !!node.get(N('TrimBox'));
        const hasTrim = rawTrim && !same(box, media);
        const noTrim = rawTrim ? 'the TrimBox is the same as the page (no trim set)' : 'no TrimBox';
        const rot = p.getRotation().angle || 0;
        const quarter = ((rot % 180) + 180) % 180 === 90;
        let found = null, tooBig = false, keep = false;
        const diag = {};
        if (custom) {
          // Manual size, as seen on screen, centred on the page's trim/crop area.
          const [w, h] = quarter ? [custom.h, custom.w] : [custom.w, custom.h];
          const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
          box = { x0: cx - w / 2, x1: cx + w / 2, y0: cy - h / 2, y1: cy + h / 2 };
          warn(`${pn}trim set by hand to ${mm(custom.w)} × ${mm(custom.h)} mm, centred on the page.`);
          if (box.x0 < media.x0 - 0.3 || box.y0 < media.y0 - 0.3 || box.x1 > media.x1 + 0.3 || box.y1 > media.y1 + 0.3)
            { tooBig = true; warn(`${pn}the trim size set is bigger than the page; the edges will be blank.`); }
        } else if (!hasTrim) {
          try { found = findCropMarks(PDFLib, p, media, diag); } catch (e) { found = null; diag.reason = 'unreadable'; }
          if (found) {
            box = { x0: found.x0, y0: found.y0, x1: found.x1, y1: found.y1 };
            warn(`${pn}${noTrim}; trim of ${mm(box.x1 - box.x0)} × ${mm(box.y1 - box.y0)} mm found from the crop marks on the page` +
              (found.score < 8 ? ` (${found.score} of 8 marks).` : '.'));
          }
        }
        const tw = box.x1 - box.x0, th = box.y1 - box.y0;
        if (custom || found) {
          // Nothing to add.
        } else if (!hasTrim) {
          const guess = looksLikeBleed(tw / MM, th / MM);
          const why = {
            complex: `${noTrim}, and the page is too complex to check for crop marks`,
            unreadable: `${noTrim}, and the page content couldn't be read to check for crop marks`,
            ambiguous: `${noTrim}, and found more than one possible set of crop marks (set the trim size by hand)`,
          }[diag.reason] || (rawTrim ? `${noTrim}, and there are no crop marks` : 'no TrimBox or crop marks');
          warn(`${pn}${why}, so the page size (${mm(tw)} × ${mm(th)} mm) is used as the trim.` +
            (guess ? ` It looks like ${guess} already, so check it and set` : ' If that\'s wrong, set') + ' it under Trim size > Custom.');
        } else {
          const extra = Math.min(box.x0 - media.x0, box.y0 - media.y0, media.x1 - box.x1, media.y1 - box.y1);
          // The file's own bleed: the BleedBox (else CropBox, else MediaBox), within the page.
          const bl = rect(p.getBleedBox());
          const av = { x0: Math.max(bl.x0, crop.x0, media.x0), y0: Math.max(bl.y0, crop.y0, media.y0),
            x1: Math.min(bl.x1, crop.x1, media.x1), y1: Math.min(bl.y1, crop.y1, media.y1) };
          const own = [box.x0 - av.x0, box.y0 - av.y0, av.x1 - box.x1, av.y1 - box.y1];
          const enough = own.map((v) => v >= b - 0.01);
          if (opts.keepBleed === true && b > 0 && enough.every(Boolean)) {
            keep = true;
            warn(cap(`${pn}kept the file's own ${+opts.bleedMm.toFixed(2)} mm bleed.`));
          } else if (opts.keepBleed === true && b > 0 && extra >= -0.3 && enough.some(Boolean)) {
            warn(cap(`${pn}file has bleed on only some sides; mirrored bleed used instead.`));
          } else if (extra < -0.3) warn(`${pn}the TrimBox extends beyond the page; the edges will be blank.`);
          else if (extra > 0.3) warn(`${pn}already has ${mm(extra)} mm or more beyond the trim; it is replaced by the new bleed.`);
        }
        if (!tooBig && (crop.x0 > box.x0 + 0.3 || crop.y0 > box.y0 + 0.3 || crop.x1 < box.x1 - 0.3 || crop.y1 < box.y1 - 0.3))
          warn(`${pn}CropBox is smaller than the trim; artwork hidden by the crop will show.`);

        // The page content becomes a Form XObject in source page space, read straight from the
        // source (not through the copier, so no unused copies end up in the file). Only the
        // resources (fonts, images, colour spaces ...) go through the copier.
        let ref = null;
        const contents = node.lookup(N('Contents'));
        if (contents) {
          const streams = contents instanceof PDFArray ? contents.asArray().map((r) => src.context.lookup(r)) : [contents];
          if (!streams.every((st) => st instanceof PDFRawStream)) {
            throw new Error(`Page ${idx + 1} content is damaged. Re-save it from Acrobat and try again.`);
          }
          const form = { Type: 'XObject', Subtype: 'Form', BBox: [media.x0, media.y0, media.x1, media.y1] };
          const res = node.getInheritableAttribute(N('Resources'));
          if (res) form.Resources = copier.copy(res);
          const one = streams.length === 1 ? streams[0] : null;
          const plain = one && one.dict.keys().every((k) => ['/Length', '/Filter', '/DecodeParms'].includes(k.asString()));
          if (plain) {
            // Single stream: the encoded bytes and their filters go in untouched.
            const dict = ctx.obj(form);
            for (const k of ['Filter', 'DecodeParms']) {
              const v = one.dict.get(N(k));
              if (v) dict.set(N(k), copier.copy(v));
            }
            ref = ctx.register(PDFRawStream.of(dict, one.getContents()));
          } else {
            // Several streams (or extra stream keys): decode, join with newlines, recompress.
            const parts = [];
            for (const st of streams) parts.push(decodePDFRawStream(st).decode(), new Uint8Array([10]));
            ref = ctx.register(ctx.flateStream(concat(parts), form));
          }
        }
        sources.push({ ref, keep });
        const s = sources[sources.length - 1];
        s.base = visualMatrix(box, rot);
        s.srcTrim = [box.x0, box.y0, box.x1, box.y1];
        s.W = quarter ? th : tw;
        s.H = quarter ? tw : th;
        // The artwork as supplied: the visible page (CropBox within the MediaBox), as seen on screen.
        const vw = Math.min(crop.x1, media.x1) - Math.max(crop.x0, media.x0);
        const vh = Math.min(crop.y1, media.y1) - Math.max(crop.y0, media.y0);
        s.artW = quarter ? vh : vw;
        s.artH = quarter ? vw : vh;
        s.from = custom ? 'set by hand' : found ? 'crop marks' : hasTrim ? 'TrimBox' : 'page size';
        const group = node.get(N('Group'));
        if (group) s.group = copier.copy(group);
      });
    } else {
      const img = kind === 'png' ? await embedPng(srcBytes) : embedJpeg(srcBytes);
      const dpi = img.dpi || DEFAULT_DPI;
      warn(img.dpi ? `Image placed at its own ${Math.round(dpi)} dpi.`
        : `Image has no dpi saved, so it is placed at ${DEFAULT_DPI} dpi. Check the size, or set the resolution in Photoshop and re-save.`);
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
      sources.push({ ref: img.ref, base, W: tw, H: th, artW: W, artH: H, from: custom ? 'set by hand' : 'image size' });
    }
    checkSizes(sources, warn);

    function iccStream(bytes, n, compressed) {
      const alt = n === 4 ? 'DeviceCMYK' : n === 1 ? 'DeviceGray' : 'DeviceRGB';
      const dict = { N: n, Alternate: alt };
      const s = compressed ? ctx.stream(bytes, { ...dict, Filter: 'FlateDecode' }) : ctx.flateStream(bytes, dict);
      return ctx.obj([N('ICCBased'), ctx.register(s)]);
    }

    // JPEG: the compressed data goes in unchanged.
    function embedJpeg(bytes) {
      const j = parseJpeg(bytes);
      if ((j.sof >= 0xc9 && j.sof <= 0xcf) || j.bpc === 12)
        throw new Error("Arithmetic-coded or 12-bit JPEG isn't supported by most RIPs; re-save it as a normal JPEG.");
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
      const why = [hasAlpha && 'with transparency', p.interlace && 'interlaced'].filter(Boolean).join(', ');
      if (p.bitDepth === 16) warn(`16-bit PNG (${why}) was reduced to 8-bit.`);
      if (p.colorType === 0 || p.colorType === 4)
        warn(`Greyscale PNG (${why}) was converted to RGB (will print 4-colour)` +
          (p.iccZ ? '; its greyscale colour profile was dropped.' : '.'));
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

    // Standards rules (see standardsOf): keep the source's version and claim valid.
    const claims = [std.pdfx && `PDF/X-${std.pdfx}`, std.pdfa && `PDF/A-${std.pdfa}`].filter(Boolean);
    const strict = std.pdfx === '1a' || std.pdfx === '3' || std.pdfa === 1; // no transparency, no object streams
    if (claims.length) warn(`Source is ${claims.join(' and ')}: claim kept; re-verify in Acrobat Preflight before sending.`);
    const version = std.version;
    const objectStreams = !version || (+version >= 1.5 && !strict);

    const info = [];
    for (const s of sources) {
      const { W, H } = s;
      const page = out.addPage([W + 2 * margin, H + 2 * margin]);
      if (s.group) page.node.set(N('Group'), s.group);
      const ox = margin, oy = margin;
      if (W + 2 * margin > 14400 || H + 2 * margin > 14400)
        warn('Page is larger than the 5.08 m PDF limit; some software will refuse it.');

      if (s.ref && s.keep) {
        // The file's own bleed: the page drawn once, clipped to trim ± bleed. No pieces, no seams.
        const name = page.node.newXObject('Art', s.ref);
        page.pushOperators(
          pushGraphicsState(),
          rectangle(ox - b, oy - b, W + 2 * b, H + 2 * b), clip(), endPath(),
          concatTransformationMatrix(...mul(s.base, [1, 0, 0, 1, ox, oy])),
          drawObject(name),
          popGraphicsState(),
        );
      } else if (s.ref) {
        const name = page.node.newXObject('Art', s.ref);
        // Bleed scale: mirror = 1:1 reflection; stretch = sliver scaled out to bleed width.
        const sliver = Math.max(0.01, (opts.sliverMm || 0.5) * MM);
        const k = opts.mode === 'stretch' ? b / sliver : 1;

        // Each piece is clipped exactly to its own cell, so the trim area is the original artwork.
        // (Viewers may show faint hairlines where pieces meet; they don't print.)
        const span = (side, o, len) => (side < 0 ? [o - b, b] : side > 0 ? [o + len, b] : [o, len]);
        const cells = [[0, 0]];
        for (const j of [-1, 0, 1]) for (const i of [-1, 0, 1]) if (i || j) cells.push([i, j]);
        for (const [i, j] of cells) {
          if (b <= 0 && (i || j)) continue;
          const [sx, ex] = axis(i, ox, W, k);
          const [sy, ey] = axis(j, oy, H, k);
          const [cx, cw] = span(i, ox, W);
          const [cy, ch] = span(j, oy, H);
          page.pushOperators(
            pushGraphicsState(),
            rectangle(cx, cy, cw, ch), clip(), endPath(),
            concatTransformationMatrix(...mul(s.base, [sx, 0, 0, sy, ex, ey])),
            drawObject(name),
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
      info.push({ wMm: W / MM, hMm: H / MM, artWMm: s.artW / MM, artHMm: s.artH / MM, from: s.from, srcTrim: s.srcTrim });
    }

    function addColorSpace(node, ref) {
      const { Resources } = node.normalizedEntries();
      let cs = Resources.lookupMaybe(N('ColorSpace'), PDFDict);
      if (!cs) { cs = ctx.obj({}); Resources.set(N('ColorSpace'), cs); }
      cs.set(N('Reg'), ref);
      return N('Reg');
    }

    // Trailer /ID: the source's permanent ID (or a new one) and a new changing ID.
    ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(toHex(firstId || randomBytes(16))), PDFHexString.of(toHex(randomBytes(16)))]);

    const setVersion = version && /^\d\.\d$/.test(version);
    if (setVersion) out.context.header = PDFHeader.forVersion(+version[0], +version[2]);
    const bytes = await out.save({ useObjectStreams: objectStreams });
    const head = String.fromCharCode(...bytes.subarray(0, 8));
    if (setVersion && head !== `%PDF-${version}`) {
      // pdf-lib's writers always print %PDF-1.7 (they ignore context.header), so patch the
      // two digits in place; the length doesn't change, so every offset stays valid.
      if (head !== '%PDF-1.7') throw new Error('Unexpected PDF header from pdf-lib: ' + head);
      bytes[5] = version.charCodeAt(0);
      bytes[7] = version.charCodeAt(2);
    }
    await checkOutput(PDFLib, bytes, sources, b);
    return { bytes, pages: info, warnings };
  }

  const api = { addBleed, validateOpts, MM, parseJpeg, parsePng, findCropMarks };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Bleedline = api;
})(typeof self !== 'undefined' ? self : this);
