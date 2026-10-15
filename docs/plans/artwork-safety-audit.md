status: active

# Artwork safety audit: fixes before coworker rollout

Goal: be certain the app changes nothing in customer artwork except adding bleed and trim marks.
Audit date: 2026-10-09. I read all of `src/bleed.js` and `src/index.html` and tested the risky paths in Node.
The committed `Bleedline.html` matched a fresh build of `src/`.

## 1. Auto trim can crop the artwork to a table cell (critical)

**Problem.** A PDF with no TrimBox, or with a TrimBox the same size as the MediaBox (most exports), goes
through `findCropMarks` (`src/bleed.js`). Table borders drawn as separate short segments, as Word and Excel
export them, pass as crop marks. When several rectangles qualify, the code picks the smallest one, so it
chooses a single cell.

**Repro.** An A5 page with TrimBox = MediaBox and a table of 80 × 40 pt cells drawn as per-cell `m l S` segments.
The output was a 28.2 × 14.1 mm page cut from one cell, with everything else dropped. The only signs were a
warning and the trim size shown in the header.

**Fix.**
- Accept marks only in the margins. Every mark segment used must lie outside the candidate trim rectangle and
  near a corner, i.e. within ~`maxL` of the corner it extends.
- Reject a candidate if other detected lines cross into it from outside, or if marks are found inside it.
- Require the trim to cover most of the page (e.g. at least 50% of the MediaBox area) and to be roughly centred.
- Between valid candidates, prefer the most complete set, then the **outermost** set of marks that are still
  inside any bleed marks, not just the smallest area.
- Add a regression test using the table repro, alongside real crop-mark files (InDesign, Illustrator, Acrobat
  "Add printer marks") that must still be detected.

## 2. "Hide on-screen seams" changes the trim area and is on by default

**Problem.** When it is on, bleed pieces are painted over the outer 0.75 pt (0.26 mm) of the trim. The mirror is
reflected about a line 0.75 pt inside the trim, so the original content in that strip appears nowhere in the
output. For example, a hairline frame drawn on the trim disappears. This is documented in the help, but it does
change the trim area, and it is the default.

**Fix.**
- Make it **off** by default, so a plain run leaves the trim area exactly as supplied. Keep it as an opt-in
  for on-screen proofs.
- Existing users have `hideSeams: true` saved in localStorage. Bump the settings key, or ignore the saved value
  for this one option, so the new default actually applies.
- Update the help text and hint to match.

## 3. Output still claims PDF/X but no longer conforms

**Problem.** The document info dictionary and XMP are copied verbatim, so `GTS_PDFXVersion` and `pdfxid` carry
over. The output, however:
- is written as `%PDF-1.7`, while X-1a and X-3 require 1.3 or 1.4;
- uses object streams (`useObjectStreams` defaults to true in pdf-lib), which X-1a and X-3 don't allow;
- adds transparency groups when seam-hiding is on, which X-1a and X-3 don't allow.

A preflight check or a strict RIP will flag or reject the file.

**Fix (pick one).**
- A. Keep the claim valid: save with `useObjectStreams: false`, set the header to the source file's version
  (e.g. `out.context.header` from the source), and skip the transparency-group seam trick for PDF/X-1a and X-3
  sources (clip exactly instead). Fixing #2 already covers the default case.
- B. Remove the claim: strip `GTS_PDFXVersion` / `GTS_PDFXConformance` from the info dictionary, and the PDF/X
  entries from the XMP, and warn "PDF/X status removed, re-export or re-verify if required".
- A is preferable. Add a warning either way when the source claims PDF/X.

## 4. Smaller issues

- **Marks can print on the bleed.** If the mark offset is less than the bleed, the registration marks are drawn
  over the bleed artwork. Clamp the offset to at least the bleed, or warn.
- **Misleading warning.** "No TrimBox or crop marks" is shown when a TrimBox exists but equals the page.
  Change it to say "no TrimBox, or TrimBox equals the page".
- **PNG warning wording.** The 16-bit and greyscale-to-RGB warnings say "with transparency", but they also fire
  for interlaced PNGs without alpha. Base the wording on the actual reason.
- **README and help wording.** They say PDF content is copied "byte-for-byte". Content streams are decoded and
  re-Flate-compressed by pdf-lib's `PDFPageEmbedder`. This is lossless and the operators are identical, but
  the wording should say "copied unchanged (recompressed losslessly)". Fonts, images and other resources really
  are byte-identical.

## 5. Found on second pass (2026-10-09)

Confirmed in Node unless noted.

- **Typing a negative bleed cuts into the artwork (high).** `min="0"` isn't enforced on typed input and
  `bleedMm: -3` runs without error: the output page is 283 × 383 pt for a 300 × 400 pt trim, so the TrimBox is
  bigger than the page and the outer 3 mm of artwork is lost. Empty or invalid fields silently become 0
  (`parseFloat(...) || 0`). **Fix:** validate every number in `addBleed` (throw on negative bleed, sliver ≤ 0,
  NaN) and in the UI (red field, no processing). Warn when bleed is 0. In *Set size* mode with an empty W or H,
  say so instead of silently falling back to Auto.
- **Download can save the previous settings' output (high, UI).** Number inputs fire `change` on blur, and
  reprocessing waits 150 ms. Typing a new bleed and clicking Download straight away blurs the field, then the
  click downloads the old `entry.url` before reprocessing starts. Overlapping runs (a setting changed while a
  file is still processing) can also finish out of order, so the older result wins. The header's "with bleed"
  size uses the current setting, not the one the file was made with. **Fix:** on `input`/`change`, disable all
  Download buttons immediately. Give each entry a run counter and drop results from stale runs. Store the
  options used with each result and show those in the header.
- **Reversed box corners (medium).** The spec allows `[urx ury llx lly]`, but pdf-lib's `asRectangle` doesn't
  normalise it. A MediaBox of `[300 400 0 0]` gives a trim of −105.8 × −141.1 mm. **Fix:** normalise with
  min/max in `rect()`, and refuse a box with zero area.
- **Page content is stored twice (medium, file size).** `copier.copy(contents)` registers the raw streams, then
  `PDFPageEmbedder` decodes them and writes a new Flate stream. The copied originals stay in the file unreferenced
  (pdf-lib writes every object). A 10 KB source gave a 21 KB output. **Better fix than rewording #4:** build the
  Form XObject directly from the source content stream. For a single stream, reuse its encoded bytes and `/Filter`
  as they are (truly byte-for-byte). For an array of streams, concatenate decoded data as now. Don't copy
  `Contents` through the copier.
- **No trailer `/ID` (part of #3).** `PDFDocument.create()` sets no ID and the output has none. PDF/X-1a, X-3 and
  X-4 all require one. Option A must add it (new random ID, or the source's first ID with a new second one).
  The `%PDF-1.7` header also breaks a PDF/X-4 claim, not just X-1a and X-3.
- **PDF/A claims (part of #3).** `pdfaid` in the XMP is copied the same way. Handle it like PDF/X: keep it only if
  the output still conforms, otherwise strip it and warn. Also give the XMP a new `xmpMM:InstanceID`, so the output
  doesn't claim to be the source file.
- **The crop-mark budget doesn't fail safe (part of #1).** The audit says detection returns null on very large
  content. In fact, when the 400,000-operator budget runs out, `run` returns early but `collectLines` still returns
  the lines found so far, and `findCropMarks` uses them. **Fix:** return `[]` (or null) when the budget is hit.
- **More crop-mark filters (part of #1).** `collectLines` ignores stroke width, colour, form `/BBox` clipping and
  optional content. Lines in a hidden layer (`BDC /OC` with that layer OFF), lines clipped out by a form BBox, and
  lines thicker than ~1 pt shouldn't count as marks. Real marks are usually registration or 100% K. A dieline drawn
  as separate segments is the same failure as the table cell.
- **Existing bleed is always thrown away (feature).** A file with a TrimBox and a real designer-made bleed of at
  least the requested amount gets it replaced by a mirror. Add a *Keep existing bleed when it's big enough*
  option (on by default) that uses the original artwork out to the bleed and only adds marks.
- **Set size applies to every file in the session (UI).** A size set for file A is applied to file B when it's
  dropped later. The warning shows, but it's easy to miss in a batch. Prefer per-file *Set size*, or switch back
  to Auto when new files are added and say so.
- **Smaller notes.**
  - No warning when the TrimBox extends beyond the MediaBox, so the edges come out blank.
  - Output pages bigger than 14,400 pt (5.08 m) exceed the PDF page limit, which matters for wide format. Warn.
  - A greyscale PNG with transparency loses its grey ICC profile when it's converted to RGB. The warning should
    say so.
  - Arithmetic-coded (SOF9–SOF15) and 12-bit JPEGs are passed into DCTDecode, which many RIPs can't read.
    Refuse them or warn.
  - The comment at the top of `bleed.js` also says "byte-for-byte". Update it with the README and help.

## 6. Rollout process

- **Automated trim-area check.** There's no `npm test`. Add a Node script that runs a folder of sample files
  through `addBleed` and renders the source trim and the output trim with Ghostscript at 300 dpi, then compares
  them pixel by pixel (seam-hiding off). This replaces the manual Acrobat comparison in the checklist and stays
  usable as a regression test.
- **Build stamp.** Show the build date and commit in the help dialog, so it's possible to tell whether a
  coworker's copy of `Bleedline.html` on the shared drive is current. After the fixes, replace every distributed copy.

## Verified OK (no change needed)

- Page content is drawn directly (no group), clipped exactly to the trim. Blend modes, overprint, optional
  content and the page `/Group` behave the same as in the original.
- Fonts, images, colour spaces, ICC profiles, layers (with their on/off state) and output intents are copied
  unchanged through one shared `PDFObjectCopier`.
- `/Rotate` 90, 180 and 270 are mapped correctly to an upright output page.
- JPEG data is embedded unchanged; Adobe CMYK inversion is handled with `Decode [1 0 1 0 1 0 1 0]`, and
  multi-chunk ICC profiles are reassembled in order.
- PNGs without alpha or interlacing pass through losslessly, including 16-bit, greyscale and indexed images.
- Encrypted, damaged, and `UserUnit` PDFs are refused.
- Printable annotations are excluded, with a warning.
- Crop-mark detection fails safe (returns null) on parse errors. (Not on very large content: see #5.)

## Rollout checklist

Moved to [artwork-safety-fixes.md](artwork-safety-fixes.md), which plans every fix above in build order.
