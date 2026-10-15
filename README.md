# Bleedline

**Use it online:** https://mylandurray.github.io/bleedline/

A single offline web page that adds bleed and trim marks to finished-size artwork, like Acrobat's *Add Bleed* tool.
Drop in a PDF, JPG or PNG and download `name_bleed.pdf`.

- **Mirror** mode reflects the artwork edge into the bleed; **Stretch edge** stretches a thin edge sliver across it.
- Stays vector: the original page is placed and redrawn flipped/stretched into each bleed strip, not rasterised.
- PDF page content, fonts and images are copied unchanged (byte-for-byte for single-stream pages; multi-part page
  content is joined and recompressed losslessly). JPEG data is embedded as is, PNGs losslessly.
  Layers, output intent, XMP, document info and transparency settings are carried over.
- PDF/X and PDF/A files keep their claim: the output keeps the source's PDF version, and for PDF/X-1a, X-3 and
  PDF/A-1 it uses no object streams or transparency. A warning reminds you to re-verify in Acrobat Preflight.
- PDFs that already have enough bleed beyond a real TrimBox keep their own artwork as the bleed (on by default; it falls
  back to mirroring, with a warning, if any side is short).
- Trim marks in registration colour (separation `All`); TrimBox and BleedBox set. Multi-page PDFs and page rotation supported.
- Trim comes from the PDF's TrimBox, or crop marks found on the page when there isn't one, or a size you set by hand
  for each file.
  Crop marks are used only when they're unambiguous (thin marks in the margins at the corners, nothing drawn along the
  trim itself, trim covering most of the page); otherwise the page size is used and a warning says why.
- Warns about anything that needs a check (no TrimBox, existing bleed, printable annotations, layers, image dpi/profile)
  and refuses password-protected or damaged PDFs.
- Runs entirely in the browser, files never leave the PC. No install, no internet needed.

## Use

Open the link above, or copy `Bleedline.html` to a PC or shared drive and double-click it (Chrome or Edge) to use it offline.
Either way, files are processed in the browser and never uploaded.
Full instructions are in the page: click **?** (or press F1).

## Build

`Bleedline.html` is generated; edit `src/` and rebuild:

```
npm install
npm run build
```

`npm test` runs the unit tests. `npm run check-samples` renders the PDFs in `test/samples/` (not in git) before and after with Ghostscript and reports any pixel differences inside the trim; it prints install instructions if Ghostscript is missing.

`index.html` just redirects GitHub Pages to `Bleedline.html`. `build.mjs` inlines `pdf-lib` and `src/bleed.js` into `src/index.html` to produce the one-file `Bleedline.html`.
