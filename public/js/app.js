(() => {
  const tabs = document.querySelectorAll(".tab");
  const panels = document.querySelectorAll(".panel");

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      panels.forEach((p) => (p.hidden = true));
      tab.classList.add("active");
      const target = document.getElementById(tab.dataset.panel);
      target.hidden = false;
      // A tab's target can itself contain nested .panel steps (e.g. a
      // multi-step workflow) — those got hidden by the loop above too,
      // so un-hide them along with their container.
      target.querySelectorAll(".panel").forEach((p) => (p.hidden = false));
    });
  });

  panels.forEach(initPanel);

  function initPanel(panel) {
    const dropzone = panel.querySelector(".dropzone");
    const input = dropzone.querySelector("input[type=file]");
    const fileListEl = panel.querySelector(".filelist");
    const convertBtn = panel.querySelector(".btn-convert");
    const statusEl = panel.querySelector(".status");
    const progressEl = panel.querySelector(".progress");
    const progressBarEl = panel.querySelector(".progress-bar");
    const multi = panel.dataset.multi === "true";
    const endpoint = panel.dataset.endpoint;
    const minFiles = parseInt(panel.dataset.minFiles || "1", 10);
    const targetEl = panel.querySelector("select, input[name=target]");
    const rangesEl = panel.querySelector("input[name=ranges]");

    let files = [];

    dropzone.addEventListener("click", () => input.click());
    dropzone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") input.click();
    });

    ["dragenter", "dragover"].forEach((evt) =>
      dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.add("drag");
      })
    );
    ["dragleave", "drop"].forEach((evt) =>
      dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.remove("drag");
      })
    );
    dropzone.addEventListener("drop", (e) => {
      addFiles(Array.from(e.dataTransfer.files));
    });
    input.addEventListener("change", () => {
      addFiles(Array.from(input.files));
      input.value = "";
    });

    function addFiles(newFiles) {
      if (!multi) {
        files = newFiles.slice(0, 1);
      } else {
        files = files.concat(newFiles);
      }
      renderList();
    }

    function renderList() {
      fileListEl.innerHTML = "";
      files.forEach((f, idx) => {
        const li = document.createElement("li");
        const ext = f.name.split(".").pop().toUpperCase();
        li.innerHTML = `<span>${escapeHtml(f.name)} <span class="ext-tag">${ext}</span></span>`;
        const rm = document.createElement("button");
        rm.textContent = "Remove";
        rm.addEventListener("click", () => {
          files.splice(idx, 1);
          renderList();
        });
        li.appendChild(rm);
        fileListEl.appendChild(li);
      });
      convertBtn.disabled = files.length === 0 || files.length < minFiles;
      statusEl.className = "status";
      statusEl.textContent =
        files.length > 0 && files.length < minFiles
          ? `Add at least ${minFiles} files`
          : "";
    }

    convertBtn.addEventListener("click", () => {
      if (files.length === 0 || files.length < minFiles) return;
      convertBtn.disabled = true;
      statusEl.className = "status";
      statusEl.textContent = "Uploading...";
      showProgress(0);

      const form = new FormData();
      if (multi) {
        files.forEach((f) => form.append("files", f));
      } else {
        form.append("file", files[0]);
      }
      if (targetEl) form.append("target", targetEl.value);
      if (rangesEl && rangesEl.value.trim()) form.append("ranges", rangesEl.value.trim());

      const xhr = new XMLHttpRequest();
      xhr.open("POST", endpoint);
      xhr.responseType = "blob";

      xhr.upload.addEventListener("progress", (e) => {
        if (!e.lengthComputable) return;
        const pct = Math.round((e.loaded / e.total) * 100);
        showProgress(pct);
        statusEl.textContent = pct < 100 ? `Uploading... ${pct}%` : "Converting...";
      });

      xhr.addEventListener("load", () => {
        hideProgress();
        if (xhr.status >= 200 && xhr.status < 300) {
          const disposition = xhr.getResponseHeader("Content-Disposition") || "";
          const match = disposition.match(/filename="?([^"]+)"?/);
          const filename = match ? match[1] : "converted";
          downloadBlob(xhr.response, filename);
          statusEl.className = "status ok";
          statusEl.textContent = "Done — download started.";
          convertBtn.disabled = files.length === 0 || files.length < minFiles;
        } else {
          parseErrorBlob(xhr.response).then((message) => {
            statusEl.className = "status error";
            statusEl.textContent = message || `Server error (${xhr.status})`;
            convertBtn.disabled = files.length === 0 || files.length < minFiles;
          });
        }
      });

      xhr.addEventListener("error", () => {
        hideProgress();
        statusEl.className = "status error";
        statusEl.textContent = "Network error, please try again.";
        convertBtn.disabled = files.length === 0 || files.length < minFiles;
      });

      xhr.send(form);
    });

    function showProgress(pct) {
      if (!progressEl || !progressBarEl) return;
      progressEl.hidden = false;
      progressBarEl.style.width = pct + "%";
    }

    function hideProgress() {
      if (!progressEl) return;
      progressEl.hidden = true;
      progressBarEl.style.width = "0%";
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function parseErrorBlob(blob) {
    try {
      const text = await blob.text();
      const data = JSON.parse(text);
      return data && data.error;
    } catch {
      return null;
    }
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
})();
