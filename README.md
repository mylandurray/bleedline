# Bleedline (Add Bleed)

**Use it online:** https://mylandurray.github.io/bleedline/

A single offline web page that adds bleed and trim marks to finished-size artwork, like Acrobat's *Add Bleed*.
Drop in a PDF, JPG or PNG and download `name_bleed.pdf`.

- **Mirror** mode reflects the artwork edge into the bleed; **Stretch edge** stretches a thin edge sliver across it.
- Stays vector: the original page is placed and redrawn flipped/stretched into each bleed strip, not rasterised.
- Artwork is passed through untouched: PDF content, fonts and JPEG data are copied byte-for-byte, PNGs losslessly.
  Layers, output intent, XMP, document info and transparency settings are carried over.
- Trim marks in registration colour (separation `All`); TrimBox and BleedBox set. Multi-page PDFs and page rotation supported.
- Trim comes from the PDF's TrimBox, or crop marks found on the page when there isn't one, or a size you set by hand.
  Crop marks are used only when they're unambiguous (thin marks in the margins at the corners, nothing drawn along the
  trim itself, trim covering most of the page); otherwise the page size is used and a warning says why.
- Warns about anything that needs a check (no TrimBox, existing bleed, printable annotations, layers, image dpi/profile)
  and refuses password-protected or damaged PDFs.
- Runs entirely in the browser, files never leave the PC. No install, no internet needed.

## Use

Open the link above, or copy `AddBleed.html` to a PC or shared drive and double-click it (Chrome or Edge) to use it offline.
Either way, files are processed in the browser and never uploaded.
Full instructions are in the page under **? Help** (or press F1).

## Build

`AddBleed.html` is generated; edit `src/` and rebuild:

```
npm install
npm run build
```

`index.html` just redirects GitHub Pages to `AddBleed.html`. `build.mjs` inlines `pdf-lib` and `src/bleed.js` into `src/index.html` to produce the one-file `AddBleed.html`.
