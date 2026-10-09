status: active

# Artwork safety audit: fixes before coworker rollout

Goal: be certain the app changes nothing in customer artwork except adding bleed and trim marks.
Audit date: 2026-10-09. I read all of `src/bleed.js` and `src/index.html` and tested the risky paths in Node.
The committed `AddBleed.html` matched a fresh build of `src/`.

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
- Crop-mark detection fails safe (returns null) on parse errors and on very large content.

## Rollout checklist

- [ ] #1 crop-mark detection made strict, with a regression test
- [ ] #2 seam-hiding off by default (saved settings handled), help updated
- [ ] #3 PDF/X handled (option A or B)
- [ ] #4 small fixes
- [ ] Rebuild `AddBleed.html`, then run a set of real customer files (with and without a TrimBox, crop marks,
      rotated pages, PDF/X-1a, spot colours and overprint, layers, JPG/PNG) and compare each output's trim area
      against the original in Acrobat Output Preview, or by diffing Ghostscript renders.
- [ ] Set this plan to `status: done`.
