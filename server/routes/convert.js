const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs/promises");
const fssync = require("fs");
const archiver = require("archiver");
const { randomUUID: uuid } = require("crypto");

const {
  convertImage,
  imagesToPdf,
  pdfToImages,
  officeConvert,
  pdfToDocxSmart,
  mergePdfs,
  splitPdf,
  applyPdfEdits,
} = require("../lib/converters");

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
const CONVERTED_DIR = path.join(__dirname, "..", "converted");

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 25 * 1024 * 1024, files: 20 }, // 25MB/file, 20 files
});

// The edit-pdf-apply route embeds inserted images as base64 inside a single
// "elements" form field (not as separate file uploads), so it needs a much
// higher fieldSize than multer's 1MB default.
const uploadWithLargeFields = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 25 * 1024 * 1024, fieldSize: 20 * 1024 * 1024 },
});

const IMAGE_FORMATS = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif", "tiff", "bmp"]);
const OFFICE_EXT_TO_LO = {
  docx: "docx", doc: "doc", odt: "odt",
  xlsx: "xlsx", xls: "xls", ods: "ods",
  pptx: "pptx", ppt: "ppt", odp: "odp",
};

async function cleanup(paths) {
  await Promise.all(
    paths.map((p) => fs.rm(p, { recursive: true, force: true }).catch(() => {}))
  );
}

function jobDir(base) {
  const dir = path.join(base, uuid());
  fssync.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------- IMAGE <-> IMAGE ----------
router.post("/image", upload.array("files"), async (req, res) => {
  const target = (req.body.target || "").toLowerCase();
  if (!IMAGE_FORMATS.has(target)) return res.status(400).json({ error: "Invalid target format" });

  const outDir = jobDir(CONVERTED_DIR);
  const toCleanup = [outDir, ...req.files.map((f) => f.path)];
  try {
    const outputs = [];
    for (const file of req.files) {
      const base = path.parse(file.originalname).name;
      const outPath = path.join(outDir, `${base}.${target === "jpg" ? "jpg" : target}`);
      await convertImage(file.path, outPath, target);
      outputs.push(outPath);
    }
    await sendResult(res, outputs, outDir);
  } catch (e) {
    res.status(500).json({ error: "Conversion failed", detail: e.message });
  } finally {
    cleanup(toCleanup);
  }
});

// ---------- IMAGE(S) -> PDF ----------
router.post("/image-to-pdf", upload.array("files"), async (req, res) => {
  const outDir = jobDir(CONVERTED_DIR);
  const toCleanup = [outDir, ...req.files.map((f) => f.path)];
  try {
    const outPath = path.join(outDir, "converted.pdf");
    await imagesToPdf(req.files.map((f) => f.path), outPath);
    await sendResult(res, [outPath], outDir);
  } catch (e) {
    res.status(500).json({ error: "Conversion failed", detail: e.message });
  } finally {
    cleanup(toCleanup);
  }
});

// ---------- PDF -> IMAGE(S) ----------
router.post("/pdf-to-image", upload.single("file"), async (req, res) => {
  const format = (req.body.target || "jpg").toLowerCase() === "png" ? "png" : "jpg";
  const outDir = jobDir(CONVERTED_DIR);
  const toCleanup = [outDir, req.file.path];
  try {
    const outputs = await pdfToImages(req.file.path, outDir, format);
    await sendResult(res, outputs, outDir);
  } catch (e) {
    res.status(500).json({ error: "Conversion failed", detail: e.message });
  } finally {
    cleanup(toCleanup);
  }
});

// ---------- MERGE PDF ----------
router.post("/merge-pdf", upload.array("files"), async (req, res) => {
  if (!req.files || req.files.length < 2) {
    return res.status(400).json({ error: "Add at least two PDF files to merge" });
  }
  const outDir = jobDir(CONVERTED_DIR);
  const toCleanup = [outDir, ...req.files.map((f) => f.path)];
  try {
    const outPath = path.join(outDir, "merged.pdf");
    await mergePdfs(req.files.map((f) => f.path), outPath);
    await sendResult(res, [outPath], outDir);
  } catch (e) {
    res.status(500).json({ error: "Merge failed — make sure every file is a valid PDF", detail: e.message });
  } finally {
    cleanup(toCleanup);
  }
});

// ---------- SPLIT PDF ----------
router.post("/split-pdf", upload.single("file"), async (req, res) => {
  const outDir = jobDir(CONVERTED_DIR);
  const toCleanup = [outDir, req.file.path];
  try {
    const outputs = await splitPdf(req.file.path, outDir, req.body.ranges);
    await sendResult(res, outputs, outDir);
  } catch (e) {
    res.status(400).json({ error: e.message || "Split failed — make sure the file is a valid PDF", detail: e.message });
  } finally {
    cleanup(toCleanup);
  }
});

// ---------- EDIT PDF: apply overlay edits (text/shapes/images) from the in-browser editor ----------
router.post("/edit-pdf-apply", uploadWithLargeFields.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No PDF file received" });
  let elements;
  try {
    elements = JSON.parse(req.body.elements || "{}");
  } catch {
    return res.status(400).json({ error: "Invalid elements data" });
  }

  const outDir = jobDir(CONVERTED_DIR);
  const toCleanup = [outDir, req.file.path];
  try {
    const outPath = path.join(outDir, "edited.pdf");
    await applyPdfEdits(req.file.path, elements, outPath);
    await sendResult(res, [outPath], outDir);
  } catch (e) {
    res.status(500).json({ error: "Could not apply edits — the file may be corrupted", detail: e.message });
  } finally {
    cleanup(toCleanup);
  }
});

// ---------- OFFICE <-> PDF (docx/xlsx/pptx/odt <-> pdf, and pdf -> docx) ----------
router.post("/office", upload.single("file"), async (req, res) => {
  const target = (req.body.target || "").toLowerCase();
  const validTargets = new Set(["pdf", ...Object.keys(OFFICE_EXT_TO_LO)]);
  if (!validTargets.has(target)) return res.status(400).json({ error: "Invalid target format" });

  const outDir = jobDir(CONVERTED_DIR);
  const toCleanup = [outDir, req.file.path];
  try {
    // multer strips extension; restore it so LibreOffice knows the source type
    const ext = path.extname(req.file.originalname);
    const renamed = path.join(path.dirname(req.file.path), `${path.basename(req.file.path)}${ext}`);
    await fs.rename(req.file.path, renamed);
    toCleanup[1] = renamed;

    // PDF -> DOCX gets the pdf2docx path: much better at complex-script text
    // (Arabic/Persian/Kurdish, etc.) and real table reconstruction than
    // LibreOffice's generic PDF import filter.
    const isPdfToDocx = ext.toLowerCase() === ".pdf" && target === "docx";
    const outPath = isPdfToDocx
      ? await pdfToDocxSmart(renamed, outDir)
      : await officeConvert(renamed, outDir, target);
    await sendResult(res, [outPath], outDir);
  } catch (e) {
    res.status(500).json({ error: "Conversion failed — the file may be corrupted or the format unsupported", detail: e.message });
  } finally {
    cleanup(toCleanup);
  }
});

// ---------- helper: send single file directly, or zip multiple ----------
async function sendResult(res, files, outDir) {
  if (files.length === 1) {
    return res.download(files[0], path.basename(files[0]));
  }
  const zipPath = path.join(outDir, "converted.zip");
  await new Promise((resolve, reject) => {
    const output = fssync.createWriteStream(zipPath);
    const archive = archiver("zip");
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    for (const f of files) archive.file(f, { name: path.basename(f) });
    archive.finalize();
  });
  res.download(zipPath, "converted.zip");
}

module.exports = router;
