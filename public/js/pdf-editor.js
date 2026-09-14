import * as pdfjsLib from "/js/vendor/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/js/vendor/pdf.worker.min.mjs";

(() => {
  const uploadPrompt = document.getElementById("upload-prompt");
  const uploadInput = document.getElementById("initial-upload");
  const editorShell = document.getElementById("editor-shell");
  const canvas = document.getElementById("pdf-canvas");
  const overlayLayer = document.getElementById("overlay-layer");
  const pageContainer = document.getElementById("page-container");
  const thumbsEl = document.getElementById("page-thumbs");
  const zoomLevelEl = document.getElementById("zoom-level");
  const statusEl = document.getElementById("editor-status");
  const imageFileInput = document.getElementById("image-file-input");

  let pdfDoc = null;
  let pdfBytesOriginal = null; // kept to send back to the server on save
  let currentPageNum = 1;
  let scale = 1.4; // "CSS pixels per PDF point" at the current zoom level
  let currentTool = "select";
  // elements[pageNum] = array of { id, type, x, y, width, height, ... }
  // x/y/width/height are always FRACTIONS (0-1) of the page's native size —
  // this is the one and only source of truth, so zooming never desyncs
  // on-screen position from the underlying PDF coordinates.
  const elements = {};
  const nativeSize = {}; // nativeSize[pageNum] = { width, height } at scale 1
  let nextId = 1;
  let selectedElId = null;
  let dragState = null; // { id, mode: 'move'|'resize', startX, startY, orig: {x,y,width,height} }
  let pendingImagePos = null;

  // ---------- File loading ----------
  uploadPrompt.addEventListener("click", () => uploadInput.click());
  ["dragenter", "dragover"].forEach((evt) =>
    uploadPrompt.addEventListener(evt, (e) => { e.preventDefault(); uploadPrompt.classList.add("drag"); })
  );
  ["dragleave", "drop"].forEach((evt) =>
    uploadPrompt.addEventListener(evt, (e) => { e.preventDefault(); uploadPrompt.classList.remove("drag"); })
  );
  uploadPrompt.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file);
  });
  uploadInput.addEventListener("change", () => {
    if (uploadInput.files[0]) loadFile(uploadInput.files[0]);
  });

  async function loadFile(file) {
    const buf = await file.arrayBuffer();
    pdfBytesOriginal = buf.slice(0); // pdf.js detaches/transfers the buffer, so keep a copy
    pdfDoc = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
    uploadPrompt.hidden = true;
    editorShell.hidden = false;
    currentPageNum = 1;
    await renderThumbnails();
    await renderPage(currentPageNum);
  }

  async function getNativeSize(n) {
    if (!nativeSize[n]) {
      const page = await pdfDoc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      nativeSize[n] = { width: vp.width, height: vp.height };
    }
    return nativeSize[n];
  }

  // ---------- Thumbnails ----------
  async function renderThumbnails() {
    thumbsEl.innerHTML = "";
    for (let n = 1; n <= pdfDoc.numPages; n++) {
      const page = await pdfDoc.getPage(n);
      const viewport = page.getViewport({ scale: 0.18 });
      const c = document.createElement("canvas");
      c.width = viewport.width;
      c.height = viewport.height;
      await page.render({ canvasContext: c.getContext("2d"), viewport }).promise;

      const wrap = document.createElement("div");
      wrap.className = "thumb" + (n === currentPageNum ? " active" : "");
      wrap.dataset.page = n;
      wrap.appendChild(c);
      const label = document.createElement("span");
      label.textContent = n;
      wrap.appendChild(label);
      wrap.addEventListener("click", () => switchPage(n));
      thumbsEl.appendChild(wrap);
    }
  }

  function markActiveThumb() {
    thumbsEl.querySelectorAll(".thumb").forEach((t) => {
      t.classList.toggle("active", parseInt(t.dataset.page, 10) === currentPageNum);
    });
  }

  async function switchPage(n) {
    currentPageNum = n;
    selectedElId = null;
    markActiveThumb();
    await renderPage(n);
  }

  // ---------- Main page render ----------
  async function renderPage(n) {
    const page = await pdfDoc.getPage(n);
    const viewport = page.getViewport({ scale });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    overlayLayer.style.width = viewport.width + "px";
    overlayLayer.style.height = viewport.height + "px";
    pageContainer.style.width = viewport.width + "px";
    pageContainer.style.height = viewport.height + "px";
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    await getNativeSize(n);
    renderOverlayElements();
  }

  function renderOverlayElements() {
    overlayLayer.innerHTML = "";
    const size = nativeSize[currentPageNum];
    if (!size) return;
    const pageEls = elements[currentPageNum] || [];
    pageEls.forEach((el) => overlayLayer.appendChild(buildElementDom(el, size)));
  }

  // fraction -> current on-screen pixels
  function toPx(el, size) {
    return {
      left: el.x * size.width * scale,
      top: el.y * size.height * scale,
      width: el.width * size.width * scale,
      height: el.height * size.height * scale,
    };
  }

  // ---------- Zoom ----------
  document.getElementById("zoom-in").addEventListener("click", () => setZoom(scale + 0.2));
  document.getElementById("zoom-out").addEventListener("click", () => setZoom(scale - 0.2));
  function setZoom(next) {
    scale = Math.min(3, Math.max(0.5, next));
    zoomLevelEl.textContent = Math.round((scale / 1.4) * 100) + "%";
    renderPage(currentPageNum);
  }

  // ---------- Tool selection ----------
  document.querySelectorAll(".tool-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tool-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentTool = btn.dataset.tool;
      selectedElId = null;
      renderOverlayElements();
      overlayLayer.style.cursor = currentTool === "select" ? "default" : "crosshair";
    });
  });

  // ---------- Click on canvas/overlay to place a new element ----------
  overlayLayer.addEventListener("mousedown", (e) => {
    if (e.target !== overlayLayer) return; // clicks on an existing element are handled separately
    if (currentTool === "select") { selectedElId = null; renderOverlayElements(); return; }

    const size = nativeSize[currentPageNum];
    const rect = overlayLayer.getBoundingClientRect();
    const clickXFrac = (e.clientX - rect.left) / (size.width * scale);
    const clickYFrac = (e.clientY - rect.top) / (size.height * scale);

    if (currentTool === "image") {
      pendingImagePos = { xFrac: clickXFrac, yFrac: clickYFrac };
      imageFileInput.click();
      return;
    }

    const defaultsFrac = {
      text: { width: 220 / (size.width * scale), height: 34 / (size.height * scale) },
      rect: { width: 160 / (size.width * scale), height: 90 / (size.height * scale) },
    }[currentTool];
    if (!defaultsFrac) return;

    const el = {
      id: nextId++,
      type: currentTool,
      x: clickXFrac, y: clickYFrac,
      width: defaultsFrac.width, height: defaultsFrac.height,
      content: currentTool === "text" ? "Text" : undefined,
      fontSize: 16, // in PDF points, independent of zoom
      color: currentTool === "text" ? "#22304A" : "#B3401F",
      strokeWidth: 2,
    };
    (elements[currentPageNum] ||= []).push(el);
    selectedElId = el.id;
    renderOverlayElements();
    document.querySelector('.tool-btn[data-tool="select"]').click();
    if (el.type === "text") {
      requestAnimationFrame(() => {
        const dom = overlayLayer.querySelector(`[data-id="${el.id}"] .el-text`);
        if (dom) {
          dom.focus();
          const range = document.createRange();
          range.selectNodeContents(dom);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      });
    }
  });

  imageFileInput.addEventListener("change", () => {
    const file = imageFileInput.files[0];
    const pos = pendingImagePos; // capture now — pendingImagePos gets cleared before the async onload below runs
    if (!file || !pos) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const size = nativeSize[currentPageNum];
        const maxPxW = 220;
        const ratio = img.naturalHeight / img.naturalWidth;
        const wPx = Math.min(maxPxW, img.naturalWidth);
        const hPx = wPx * ratio;
        const el = {
          id: nextId++,
          type: "image",
          x: pos.xFrac, y: pos.yFrac,
          width: wPx / (size.width * scale),
          height: hPx / (size.height * scale),
          dataUrl: reader.result,
        };
        (elements[currentPageNum] ||= []).push(el);
        selectedElId = el.id;
        renderOverlayElements();
        document.querySelector('.tool-btn[data-tool="select"]').click();
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
    imageFileInput.value = "";
    pendingImagePos = null;
  });

  // ---------- Building & interacting with an overlay element's DOM ----------
  function buildElementDom(el, size) {
    const px = toPx(el, size);
    const div = document.createElement("div");
    div.className = "overlay-el overlay-el-" + el.type;
    div.dataset.id = el.id;
    div.style.left = px.left + "px";
    div.style.top = px.top + "px";
    div.style.width = px.width + "px";
    div.style.height = px.height + "px";

    if (el.type === "text") {
      const t = document.createElement("div");
      t.className = "el-text";
      t.contentEditable = "true";
      t.style.fontSize = (el.fontSize * scale) + "px";
      t.style.color = el.color;
      t.textContent = el.content;
      t.addEventListener("input", () => { el.content = t.textContent; });
      t.addEventListener("mousedown", (e) => e.stopPropagation());
      div.appendChild(t);
    } else if (el.type === "rect") {
      div.style.border = `${el.strokeWidth}px solid ${el.color}`;
    } else if (el.type === "image") {
      const img = document.createElement("img");
      img.src = el.dataUrl;
      div.appendChild(img);
    }

    if (el.id === selectedElId) div.classList.add("selected");

    div.addEventListener("mousedown", (e) => {
      if (currentTool !== "select") return;
      e.stopPropagation();
      selectedElId = el.id;
      renderOverlayElements();
      dragState = {
        id: el.id, mode: "move",
        startX: e.clientX, startY: e.clientY,
        orig: { x: el.x, y: el.y },
      };
    });

    if (el.id === selectedElId) {
      const handle = document.createElement("div");
      handle.className = "resize-handle";
      handle.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        dragState = {
          id: el.id, mode: "resize",
          startX: e.clientX, startY: e.clientY,
          orig: { width: el.width, height: el.height },
        };
      });
      div.appendChild(handle);

      const del = document.createElement("button");
      del.className = "delete-handle";
      del.textContent = "\u00d7";
      del.title = "Delete";
      del.addEventListener("mousedown", (e) => e.stopPropagation());
      del.addEventListener("click", () => {
        elements[currentPageNum] = (elements[currentPageNum] || []).filter((x) => x.id !== el.id);
        selectedElId = null;
        renderOverlayElements();
      });
      div.appendChild(del);
    }

    return div;
  }

  document.addEventListener("mousemove", (e) => {
    if (!dragState) return;
    const size = nativeSize[currentPageNum];
    const pageEls = elements[currentPageNum] || [];
    const el = pageEls.find((x) => x.id === dragState.id);
    if (!el || !size) return;
    const dxFrac = (e.clientX - dragState.startX) / (size.width * scale);
    const dyFrac = (e.clientY - dragState.startY) / (size.height * scale);
    if (dragState.mode === "move") {
      el.x = Math.max(0, dragState.orig.x + dxFrac);
      el.y = Math.max(0, dragState.orig.y + dyFrac);
    } else if (dragState.mode === "resize") {
      el.width = Math.max(0.02, dragState.orig.width + dxFrac);
      el.height = Math.max(0.02, dragState.orig.height + dyFrac);
    }
    renderOverlayElements();
  });
  document.addEventListener("mouseup", () => { dragState = null; });

  // ---------- Save & download ----------
  document.getElementById("save-btn").addEventListener("click", async () => {
    statusEl.textContent = "Applying edits...";

    const spec = {};
    for (const [pageNumStr, pageEls] of Object.entries(elements)) {
      if (!pageEls.length) continue;
      spec[pageNumStr] = pageEls.map((el) => ({
        type: el.type,
        x: el.x, y: el.y, width: el.width, height: el.height,
        content: el.content,
        fontSize: el.fontSize,
        color: el.color,
        strokeWidth: el.strokeWidth,
        dataUrl: el.dataUrl,
      }));
    }

    const form = new FormData();
    form.append("file", new Blob([pdfBytesOriginal], { type: "application/pdf" }), "document.pdf");
    form.append("elements", JSON.stringify(spec));

    try {
      const resp = await fetch("/api/convert/edit-pdf-apply", { method: "POST", body: form });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        statusEl.textContent = data.error || "Save failed.";
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "edited.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      statusEl.textContent = "Done — download started.";
    } catch (err) {
      statusEl.textContent = "Network error, please try again.";
    }
  });
})();
