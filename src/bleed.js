// Core: add mirrored/stretched bleed and crop marks to a PDF or image.
// Works in the browser (PDFLib global) and in Node (pass the pdf-lib module).
// Everything stays vector: the original page is embedded once as a Form XObject
// and redrawn flipped/stretched into each bleed strip, clipped to that strip.

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

  // One axis of a cell transform: returns [scale, offset] mapping visual u -> output.
  // side -1 = before the trim, 0 = inside, +1 = after.
  function axis(side, o, len, k) {
    if (side === 0) return [1, o];
    if (side < 0) return [-k, o];
    return [-k, o + len + k * len];
  }

  function boxOf(page) {
    const r = page.getTrimBox ? page.getTrimBox() : page.getMediaBox();
    return { x0: r.x, y0: r.y, x1: r.x + r.width, y1: r.y + r.height };
  }

  /**
   * opts: { bleedMm, mode: 'mirror'|'stretch', sliverMm, marks, markOffsetMm,
   *         markLenMm, markWeightPt, imageDpi }
   * kind: 'pdf' | 'png' | 'jpg'
   * Returns { bytes, pages: [{wMm, hMm}] }
   */
  async function addBleed(PDFLib, srcBytes, kind, opts) {
    const {
      PDFDocument, cmyk, pushGraphicsState, popGraphicsState, rectangle, clip,
      endPath, concatTransformationMatrix, drawObject,
    } = PDFLib;

    const b = opts.bleedMm * MM;
    const marks = opts.marks;
    const markOff = opts.markOffsetMm * MM;
    const markLen = opts.markLenMm * MM;
    const margin = marks ? Math.max(b, markOff + markLen) + 2 * MM : b;
    const out = await PDFDocument.create();

    // Build a list of sources: { name-producing embed, base matrix, W, H }
    const sources = [];
    if (kind === 'pdf') {
      const src = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
      const srcPages = src.getPages();
      for (const p of srcPages) {
        const mb = p.getMediaBox();
        const mediaBox = { left: mb.x, bottom: mb.y, right: mb.x + mb.width, top: mb.y + mb.height };
        // Identity matrix so form space == source page space.
        const emb = await out.embedPage(p, mediaBox, [1, 0, 0, 1, 0, 0]);
        const box = boxOf(p);
        const rot = p.getRotation().angle || 0;
        const quarter = ((rot % 180) + 180) % 180 === 90;
        const tw = box.x1 - box.x0, th = box.y1 - box.y0;
        sources.push({
          ref: emb.ref,
          base: visualMatrix(box, rot),
          W: quarter ? th : tw,
          H: quarter ? tw : th,
        });
      }
    } else {
      const img = kind === 'png' ? await out.embedPng(srcBytes) : await out.embedJpg(srcBytes);
      const dpi = opts.imageDpi || 300;
      const W = (img.width / dpi) * 72, H = (img.height / dpi) * 72;
      sources.push({ ref: img.ref, base: [W, 0, 0, H, 0, 0], W, H });
    }

    const info = [];
    for (const s of sources) {
      const { W, H } = s;
      const page = out.addPage([W + 2 * margin, H + 2 * margin]);
      const name = page.node.newXObject('Art', s.ref);
      const ox = margin, oy = margin;

      // Bleed scale: mirror = 1:1 reflection; stretch = sliver scaled out to bleed width.
      const sliver = Math.max(0.01, (opts.sliverMm || 0.5) * MM);
      const k = opts.mode === 'stretch' ? b / sliver : 1;

      const cells = [];
      for (const j of [-1, 0, 1]) for (const i of [-1, 0, 1]) cells.push([i, j]);
      // Bleed cells first, centre last so it always sits on top at the seams.
      cells.sort((p, q) => (p[0] === 0 && p[1] === 0) - (q[0] === 0 && q[1] === 0));

      for (const [i, j] of cells) {
        if (b <= 0 && (i || j)) continue;
        const [sx, ex] = axis(i, ox, W, k);
        const [sy, ey] = axis(j, oy, H, k);
        const m = mul(s.base, [sx, 0, 0, sy, ex, ey]);
        // Bleed strips overlap the trim slightly (hidden under the centre) so
        // viewers don't show an anti-aliasing hairline at the trim edge.
        const ov = 0.25;
        const cx = i < 0 ? ox - b : i === 0 ? ox : ox + W - ov;
        const cy = j < 0 ? oy - b : j === 0 ? oy : oy + H - ov;
        const cw = i === 0 ? W : b + ov, ch = j === 0 ? H : b + ov;
        page.pushOperators(
          pushGraphicsState(),
          rectangle(cx, cy, cw, ch), clip(), endPath(),
          concatTransformationMatrix(...m),
          drawObject(name),
          popGraphicsState(),
        );
      }

      if (marks) {
        const reg = cmyk(1, 1, 1, 1);
        const t = opts.markWeightPt || 0.25;
        const line = (x1, y1, x2, y2) =>
          page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: t, color: reg });
        for (const x of [ox, ox + W]) {
          line(x, oy - markOff, x, oy - markOff - markLen);
          line(x, oy + H + markOff, x, oy + H + markOff + markLen);
        }
        for (const y of [oy, oy + H]) {
          line(ox - markOff, y, ox - markOff - markLen, y);
          line(ox + W + markOff, y, ox + W + markOff + markLen, y);
        }
      }

      page.setTrimBox(ox, oy, W, H);
      page.setBleedBox(ox - b, oy - b, W + 2 * b, H + 2 * b);
      info.push({ wMm: W / MM, hMm: H / MM });
    }

    out.setProducer('AddBleed');
    out.setCreator('AddBleed');
    return { bytes: await out.save(), pages: info };
  }

  const api = { addBleed, MM };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AddBleed = api;
})(typeof self !== 'undefined' ? self : this);
