# Add Bleed

A single offline web page that adds bleed and trim marks to finished-size artwork, like Acrobat's *Add Bleed*.
Drop in a PDF, JPG or PNG and download `name_bleed.pdf`.

- **Mirror** mode reflects the artwork edge into the bleed; **Stretch edge** stretches a thin edge sliver across it.
- Stays vector: the original page is placed and redrawn flipped/stretched into each bleed strip, not rasterised.
- Artwork is passed through untouched: PDF content, fonts and JPEG data are copied byte-for-byte, PNGs losslessly.
  Layers, output intent, XMP, document info and transparency settings are carried over.
- Trim marks in registration colour (separation `All`); TrimBox and BleedBox set. Multi-page PDFs and page rotation supported.
- Warns about anything that needs a check (no TrimBox, existing bleed, printable annotations, layers, image dpi/profile)
  and refuses password-protected or damaged PDFs.
- Runs entirely in the browser, files never leave the PC. No install, no internet needed.

## Use

Copy `AddBleed.html` to a PC or shared drive and double-click it (Chrome or Edge).
Full instructions are in the page under **? Help** (or press F1).

## Build

`AddBleed.html` is generated; edit `src/` and rebuild:

```
npm install
npm run build
```

`build.mjs` inlines `pdf-lib` and `src/bleed.js` into `src/index.html` to produce the one-file `AddBleed.html`.
