const { execFile } = require("child_process");
const fs = require("fs/promises");
const path = require("path");
const sharp = require("sharp");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");

const CONVERTED_DIR = path.join(__dirname, "..", "converted");

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120000, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve({ stdout, stderr });
    });
  });
}

// ---- Image <-> Image (jpg, png, webp, gif, avif, tiff, bmp) ----
async function convertImage(inputPath, outputPath, targetFormat) {
  const fmt = targetFormat.toLowerCase() === "jpg" ? "jpeg" : targetFormat.toLowerCase();
  let pipeline = sharp(inputPath, { animated: fmt === "gif" });
  if (fmt === "jpeg") pipeline = pipeline.flatten({ background: "#ffffff" });
  await pipeline.toFormat(fmt).toFile(outputPath);
  return outputPath;
}

// ---- Image(s) -> PDF ----
async function imagesToPdf(inputPaths, outputPath) {
  const pdfDoc = await PDFDocument.create();
  for (const imgPath of inputPaths) {
    const ext = path.extname(imgPath).toLowerCase();
    // normalize to png/jpeg buffer via sharp so any input format works
    const buf = await sharp(imgPath).toFormat(
      ext === ".jpg" || ext === ".jpeg" ? "jpeg" : "png"
    ).toBuffer();
    const isJpeg = ext === ".jpg" || ext === ".jpeg";
    const embedded = isJpeg
      ? await pdfDoc.embedJpg(buf)
      : await pdfDoc.embedPng(buf);
    const page = pdfDoc.addPage([embedded.width, embedded.height]);
    page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
  }
  const bytes = await pdfDoc.save();
  await fs.writeFile(outputPath, bytes);
  return outputPath;
}

// ---- PDF -> Image(s) (returns array of file paths, one per page) ----
async function pdfToImages(inputPath, outDir, format = "jpg") {
  const base = path.join(outDir, "page");
  const fmtFlag = format === "png" ? "-png" : "-jpeg";
  await run("pdftoppm", [fmtFlag, "-r", "150", inputPath, base]);
  const files = (await fs.readdir(outDir)).filter((f) => f.startsWith("page")).sort();
  return files.map((f) => path.join(outDir, f));
}

// ---- Office <-> PDF via LibreOffice headless ----
// direction: any libreoffice-supported convert-to target, e.g. "pdf", "docx", "odt"
async function officeConvert(inputPath, outDir, targetExt) {
  const args = ["--headless", "--nologo", "--nofirststartwizard"];
  // When the source is a PDF, force the Writer PDF-import filter so text stays
  // editable (LibreOffice otherwise defaults to importing PDFs as Draw/images).
  if (path.extname(inputPath).toLowerCase() === ".pdf") {
    args.push("--infilter=writer_pdf_import");
  }
  args.push("--convert-to", targetExt, "--outdir", outDir, inputPath);
  await run("soffice", args, { env: { ...process.env, HOME: "/tmp" } });
  const base = path.basename(inputPath, path.extname(inputPath));
  const outPath = path.join(outDir, `${base}.${targetExt}`);
  await fs.access(outPath); // throws if not created
  return outPath;
}

// ---- PDF -> DOCX via pdf2docx (Python) ----
// LibreOffice's generic PDF import filter frequently extracts pre-shaped
// "presentation form" glyphs for complex scripts (Arabic/Persian/Kurdish),
// producing disconnected or reversed-looking letters, and often flattens
// tables into loose text instead of a real table. pdf2docx analyzes the
// PDF's actual layout (via PyMuPDF) and reconstructs real paragraphs and
// <w:tbl> tables with correct logical Unicode text, so this is used as the
// primary PDF->DOCX path, with LibreOffice kept as a fallback if it fails.
async function pdfToDocxSmart(inputPath, outDir) {
  const base = path.basename(inputPath, path.extname(inputPath));
  const outPath = path.join(outDir, `${base}.docx`);
  const scriptPath = path.join(__dirname, "pdf2docx_convert.py");
  try {
    await run("python3", [scriptPath, inputPath, outPath], { timeout: 180000 });
    await fs.access(outPath);
    return outPath;
  } catch (e) {
    // Fall back to LibreOffice if pdf2docx isn't available or chokes on this file
    return officeConvert(inputPath, outDir, "docx");
  }
}

// ---- Merge multiple PDFs into one, in the given order ----
async function mergePdfs(inputPaths, outputPath) {
  const merged = await PDFDocument.create();
  for (const p of inputPaths) {
    const bytes = await fs.readFile(p);
    const src = await PDFDocument.load(bytes);
    const pages = await merged.copyPages(src, src.getPageIndices());
    pages.forEach((page) => merged.addPage(page));
  }
  const outBytes = await merged.save();
  await fs.writeFile(outputPath, outBytes);
  return outputPath;
}

function hexToRgb(hex) {
  const clean = (hex || "#000000").replace("#", "");
  const bigint = parseInt(clean.length === 3
    ? clean.split("").map((c) => c + c).join("")
    : clean, 16);
  return rgb(((bigint >> 16) & 255) / 255, ((bigint >> 8) & 255) / 255, (bigint & 255) / 255);
}

// Applies an "overlay editor" spec (text boxes, rectangles, images placed by the
// in-browser PDF editor) onto the original PDF, page by page, and returns the
// resulting file path. `elementsSpec` looks like:
//   { "1": [ { type: "text", x, y, width, height, content, fontSize, color }, ... ], "2": [...] }
// x/y/width/height are all fractions (0-1) of the page's own width/height, with
// the origin at the TOP-LEFT (matching normal screen/DOM coordinates) — this
// function converts that into PDF's bottom-left-origin coordinate space.
async function applyPdfEdits(inputPath, elementsSpec, outputPath) {
  const bytes = await fs.readFile(inputPath);
  const pdfDoc = await PDFDocument.load(bytes);
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const imageCache = new Map(); // dataURL -> embedded image, in case the same image is reused

  for (const [pageNumStr, elements] of Object.entries(elementsSpec || {})) {
    const pageIndex = parseInt(pageNumStr, 10) - 1;
    if (!Array.isArray(elements) || pageIndex < 0 || pageIndex >= pdfDoc.getPageCount()) continue;
    const page = pdfDoc.getPage(pageIndex);
    const { width: pageWidth, height: pageHeight } = page.getSize();

    for (const el of elements) {
      const x = (el.x || 0) * pageWidth;
      const boxWidth = (el.width || 0) * pageWidth;
      const boxHeight = (el.height || 0) * pageHeight;
      const yTop = (el.y || 0) * pageHeight;
      const yBottomLeft = pageHeight - yTop - boxHeight; // flip to PDF's bottom-left origin

      if (el.type === "text" && el.content) {
        const fontSize = el.fontSize || 16;
        page.drawText(String(el.content), {
          x,
          y: yBottomLeft + Math.max(0, (boxHeight - fontSize) / 2), // rough vertical centering
          size: fontSize,
          font: helvetica,
          color: hexToRgb(el.color || "#22304A"),
          maxWidth: boxWidth || undefined,
        });
      } else if (el.type === "rect") {
        page.drawRectangle({
          x,
          y: yBottomLeft,
          width: boxWidth,
          height: boxHeight,
          borderColor: hexToRgb(el.color || "#B3401F"),
          borderWidth: el.strokeWidth || 2,
        });
      } else if (el.type === "image" && el.dataUrl) {
        let embedded = imageCache.get(el.dataUrl);
        if (!embedded) {
          const match = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(el.dataUrl);
          if (!match) continue;
          const imgBytes = Buffer.from(match[2], "base64");
          embedded = /jpe?g/i.test(match[1])
            ? await pdfDoc.embedJpg(imgBytes)
            : await pdfDoc.embedPng(imgBytes);
          imageCache.set(el.dataUrl, embedded);
        }
        page.drawImage(embedded, { x, y: yBottomLeft, width: boxWidth, height: boxHeight });
      }
    }
  }

  const outBytes = await pdfDoc.save();
  await fs.writeFile(outputPath, outBytes);
  return outputPath;
}

// Parse a ranges string like "1-3,5,8-9" into an array of [start,end] (1-based, inclusive).
// Returns null if the string is empty/invalid so callers can fall back to per-page split.
function parseRanges(rangesStr, pageCount) {
  if (!rangesStr || !rangesStr.trim()) return null;
  const parts = rangesStr.split(",").map((s) => s.trim()).filter(Boolean);
  const ranges = [];
  for (const part of parts) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`Invalid range: "${part}"`);
    let start = parseInt(m[1], 10);
    let end = m[2] ? parseInt(m[2], 10) : start;
    if (start > end) [start, end] = [end, start];
    if (start < 1 || end > pageCount) {
      throw new Error(`Range ${part} is out of bounds (PDF has ${pageCount} pages)`);
    }
    ranges.push([start, end]);
  }
  return ranges.length ? ranges : null;
}

// ---- Split a PDF. With no ranges: one output file per page.
// With ranges (e.g. "1-3,4-6"): one output file per range. ----
async function splitPdf(inputPath, outDir, rangesStr) {
  const bytes = await fs.readFile(inputPath);
  const src = await PDFDocument.load(bytes);
  const pageCount = src.getPageCount();
  const ranges = parseRanges(rangesStr, pageCount) || Array.from({ length: pageCount }, (_, i) => [i + 1, i + 1]);

  const outputs = [];
  const pad = String(ranges.length).length;
  for (let i = 0; i < ranges.length; i++) {
    const [start, end] = ranges[i];
    const doc = await PDFDocument.create();
    const indices = [];
    for (let p = start; p <= end; p++) indices.push(p - 1);
    const pages = await doc.copyPages(src, indices);
    pages.forEach((page) => doc.addPage(page));
    const label = start === end ? `page-${start}` : `pages-${start}-${end}`;
    const num = String(i + 1).padStart(pad, "0");
    const outPath = path.join(outDir, `${num}-${label}.pdf`);
    const outBytes = await doc.save();
    await fs.writeFile(outPath, outBytes);
    outputs.push(outPath);
  }
  return outputs;
}

module.exports = {
  convertImage,
  imagesToPdf,
  pdfToImages,
  officeConvert,
  pdfToDocxSmart,
  mergePdfs,
  splitPdf,
  applyPdfEdits,
  CONVERTED_DIR,
};
