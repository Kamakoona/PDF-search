const form = document.getElementById("search-form");
const folderInput = document.getElementById("folder");
const keywordInput = document.getElementById("keyword");
const recursiveInput = document.getElementById("recursive");
const caseInput = document.getElementById("case-sensitive");
const searchBtn = document.getElementById("search-btn");
const stopBtn = document.getElementById("stop-btn");
const restartBtn = document.getElementById("restart-btn");
const statusEl = document.getElementById("status");
const summaryEl = document.getElementById("summary");
const resultsEl = document.getElementById("results");
const localFolderBlock = document.getElementById("local-folder-block");
const cloudUploadBlock = document.getElementById("cloud-upload-block");
const fileInput = document.getElementById("file-input");
const uploadBtn = document.getElementById("upload-btn");
const uploadHint = document.getElementById("upload-hint");
const libraryEl = document.getElementById("library");
const modeBadge = document.getElementById("mode-badge");
const leadText = document.getElementById("lead-text");
const recursiveWrap = document.getElementById("recursive-wrap");

const FOLDER_KEY = "pdf-search-folder";
let appMode = "local";
let cloudFolder = "";
let activeSearch = null;
let pendingRestart = false;
let hitCount = 0;
let lastSummary = { query: "", scanned: 0, total: null, matched: 0, unreadable: 0 };

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setSearching(isSearching) {
  searchBtn.disabled = isSearching;
  stopBtn.disabled = !isSearching;
  restartBtn.disabled = !isSearching;
}

function setStatus(message, isError = false) {
  if (!message) {
    statusEl.hidden = true;
    statusEl.textContent = "";
    statusEl.classList.remove("error");
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function highlightSnippet(text, start, end) {
  const safeStart = Math.max(0, Math.min(start ?? 0, text.length));
  const safeEnd = Math.max(safeStart, Math.min(end ?? safeStart, text.length));
  return (
    escapeHtml(text.slice(0, safeStart)) +
    "<mark>" +
    escapeHtml(text.slice(safeStart, safeEnd)) +
    "</mark>" +
    escapeHtml(text.slice(safeEnd))
  );
}

function viewUrl(filePath, folder, page, name) {
  const params = new URLSearchParams({
    path: filePath,
    folder: folder || "",
    page: String(page || 1),
    name: name || "",
  });
  return `/view?${params.toString()}`;
}

function openViewer(filePath, folder, page, name) {
  const url = viewUrl(filePath, folder, page, name);
  const win = window.open(url, "_blank");
  if (win) {
    win.opener = null;
    return;
  }
  window.location.href = url;
}

function currentFolder() {
  if (appMode === "cloud") return cloudFolder || resultsEl.dataset.folder || "";
  return folderInput.value.trim();
}

function updateSummary({ query, scanned, total, matched, unreadable, running }) {
  lastSummary = {
    query: query ?? lastSummary.query,
    scanned: scanned ?? lastSummary.scanned,
    total: total !== undefined ? total : lastSummary.total,
    matched: matched ?? lastSummary.matched,
    unreadable:
      typeof unreadable === "number"
        ? unreadable
        : Array.isArray(unreadable)
          ? unreadable.length
          : (lastSummary.unreadable ?? 0),
  };

  summaryEl.hidden = false;
  const unread = lastSummary.unreadable || 0;
  summaryEl.innerHTML = `
    <span>검색어 <strong>${escapeHtml(lastSummary.query || "")}</strong></span>
    <span>검사 <strong>${lastSummary.scanned ?? 0}</strong>${lastSummary.total != null ? ` / ${lastSummary.total}` : ""}개</span>
    <span>일치 <strong>${lastSummary.matched ?? 0}</strong>개</span>
    ${unread ? `<span>읽기 실패 <strong>${unread}</strong>개</span>` : ""}
    ${running ? `<span class="summary-live">검색 중…</span>` : ""}
  `;
}

function fileCardHtml(file, index) {
  const firstPage = file.snippets?.[0]?.page || 1;
  const snippets = (file.snippets || [])
    .map(
      (s) => `
      <button
        type="button"
        class="snippet"
        data-open-pdf
        data-path="${escapeHtml(file.path)}"
        data-page="${s.page}"
        data-name="${escapeHtml(file.name)}"
      >
        <span class="snippet-page">${s.page}쪽 · 클릭하여 열기</span>
        <p class="snippet-text">${highlightSnippet(s.text, s.matchStart, s.matchEnd)}</p>
      </button>`
    )
    .join("");

  return `
    <article class="file-card" style="animation-delay: ${Math.min(index * 0.04, 0.4)}s">
      <div class="file-head">
        <button
          type="button"
          class="file-name-btn"
          data-open-pdf
          data-path="${escapeHtml(file.path)}"
          data-page="${firstPage}"
          data-name="${escapeHtml(file.name)}"
        >
          ${escapeHtml(file.name)}
        </button>
        <div class="file-meta">
          <span>일치 ${file.matchCount}회</span>
          <span>${file.pageCount}쪽</span>
        </div>
      </div>
      <p class="file-path">${escapeHtml(file.path)}</p>
      <div class="snippets">${snippets}</div>
    </article>`;
}

function appendHit(file) {
  const empty = resultsEl.querySelector(".empty");
  if (empty) empty.remove();
  resultsEl.insertAdjacentHTML("beforeend", fileCardHtml(file, hitCount));
  hitCount += 1;
}

function showEmpty() {
  if (!resultsEl.querySelector(".file-card")) {
    resultsEl.innerHTML = `<div class="empty">일치하는 PDF가 없습니다. 다른 키워드나 폴더를 시도해 보세요.</div>`;
  }
}

function finishStopped() {
  updateSummary({ ...lastSummary, matched: hitCount, running: false });
  if (hitCount > 0) {
    setStatus(`검색 중지 · 지금까지 일치 ${hitCount}개`);
  } else {
    setStatus("검색을 중지했습니다.");
    showEmpty();
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function refreshLibrary() {
  if (appMode !== "cloud") return;
  try {
    const res = await fetch("/api/library");
    if (!res.ok) return;
    const data = await res.json();
    cloudFolder = data.folder || cloudFolder;
    if (!data.files?.length) {
      libraryEl.hidden = false;
      libraryEl.innerHTML = `<p class="library-empty">아직 업로드된 PDF가 없습니다.</p>`;
      return;
    }
    libraryEl.hidden = false;
    libraryEl.innerHTML = `
      <div class="library-head">업로드된 파일 <strong>${data.total}</strong>개</div>
      <ul class="library-list">
        ${data.files
          .map(
            (f) => `
          <li>
            <span class="library-name">${escapeHtml(f.name)}</span>
            <span class="library-size">${formatSize(f.size || 0)}</span>
            <button type="button" class="library-del" data-del="${escapeHtml(f.name)}">삭제</button>
          </li>`
          )
          .join("")}
      </ul>`;
  } catch {
    // ignore
  }
}

async function readSseStream(response, onEvent, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
      const err = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLine = chunk
          .split("\n")
          .map((line) => line.trimEnd())
          .find((line) => line.startsWith("data:"));
        if (!dataLine) continue;
        const payload = dataLine.slice(5).trim();
        if (!payload) continue;
        onEvent(JSON.parse(payload));
      }
    }
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

resultsEl.addEventListener("click", (event) => {
  const target = event.target.closest("[data-open-pdf]");
  if (!target) return;
  const folder = currentFolder();
  const filePath = target.dataset.path;
  const page = Number.parseInt(target.dataset.page || "1", 10) || 1;
  const name = target.dataset.name || "";
  if (!filePath) return;
  openViewer(filePath, folder, page, name);
});

libraryEl.addEventListener("click", async (event) => {
  const btn = event.target.closest("[data-del]");
  if (!btn) return;
  const name = btn.dataset.del;
  if (!name || !confirm(`「${name}」을(를) 삭제할까요?`)) return;
  try {
    const res = await fetch(`/api/library/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.detail || "삭제에 실패했습니다.");
    }
    await refreshLibrary();
  } catch (err) {
    setStatus(err.message || "삭제에 실패했습니다.", true);
  }
});

stopBtn.addEventListener("click", () => {
  if (!activeSearch) return;
  pendingRestart = false;
  activeSearch.abort();
});

restartBtn.addEventListener("click", () => {
  if (!activeSearch) return;
  pendingRestart = true;
  activeSearch.abort();
});

uploadBtn.addEventListener("click", async () => {
  const files = fileInput.files;
  if (!files?.length) {
    setStatus("업로드할 PDF를 선택해 주세요.", true);
    return;
  }
  uploadBtn.disabled = true;
  setStatus(`PDF ${files.length}개를 업로드하는 중…`);
  try {
    const body = new FormData();
    for (const file of files) body.append("files", file);
    const res = await fetch("/api/upload", { method: "POST", body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "업로드에 실패했습니다.");
    cloudFolder = data.folder || cloudFolder;
    fileInput.value = "";
    const msg = `업로드 완료 · ${data.saved?.length || 0}개 저장` +
      (data.errors?.length ? ` · 실패 ${data.errors.length}개` : "");
    setStatus(msg, Boolean(data.errors?.length));
    await refreshLibrary();
  } catch (err) {
    setStatus(err.message || "업로드에 실패했습니다.", true);
  } finally {
    uploadBtn.disabled = false;
  }
});

async function applyConfig(data) {
  appMode = data.mode || "local";
  cloudFolder = data.storageFolder || data.defaultFolder || "";

  modeBadge.hidden = false;
  modeBadge.textContent = appMode === "cloud" ? "Cloud" : "Local";
  modeBadge.classList.toggle("cloud", appMode === "cloud");

  if (appMode === "cloud") {
    localFolderBlock.hidden = true;
    cloudUploadBlock.hidden = false;
    folderInput.required = false;
    recursiveWrap.hidden = true;
    leadText.textContent =
      "PDF를 업로드한 뒤 키워드로 검색합니다. 일치하는 파일과 구문을 바로 볼 수 있고, 클릭하면 해당 페이지가 열립니다.";
    if (data.maxUploadMb) {
      uploadHint.textContent = `파일당 최대 ${data.maxUploadMb}MB · 텍스트 PDF만 검색됩니다.`;
    }
    await refreshLibrary();
  } else {
    localFolderBlock.hidden = false;
    cloudUploadBlock.hidden = true;
    folderInput.required = true;
    recursiveWrap.hidden = false;
    const saved = localStorage.getItem(FOLDER_KEY);
    if (saved) folderInput.value = saved;
    else if (data.defaultFolder) folderInput.value = data.defaultFolder;
  }
}

async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) return;
    await applyConfig(await res.json());
  } catch {
    // 기본 로컬 UI 유지
  }
}

async function startSearch() {
  const folder = currentFolder();
  const keyword = keywordInput.value.trim();
  if (!keyword) return;
  if (appMode === "local" && !folder) {
    setStatus("PDF 폴더 경로를 입력해 주세요.", true);
    return;
  }

  if (activeSearch) {
    pendingRestart = false;
    activeSearch.abort();
    activeSearch = null;
  }

  if (appMode === "local") localStorage.setItem(FOLDER_KEY, folder);
  const controller = new AbortController();
  activeSearch = controller;
  pendingRestart = false;

  setSearching(true);
  hitCount = 0;
  lastSummary = { query: keyword, scanned: 0, total: null, matched: 0, unreadable: 0 };
  resultsEl.innerHTML = "";
  resultsEl.dataset.folder = folder;
  setStatus("PDF를 검색하는 중입니다…");
  updateSummary({ query: keyword, scanned: 0, matched: 0, running: true });

  try {
    const res = await fetch("/api/search/stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        folder: appMode === "cloud" ? "" : folder,
        keyword,
        recursive: appMode === "local" ? recursiveInput.checked : false,
        case_sensitive: caseInput.checked,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.detail || "검색에 실패했습니다.");
    }

    let lastQuery = keyword;
    let finished = false;

    await readSseStream(
      res,
      (event) => {
        if (event.type === "error") {
          throw new Error(event.detail || "검색에 실패했습니다.");
        }

        if (event.type === "start") {
          lastQuery = event.query;
          resultsEl.dataset.folder = event.folder || folder;
          if (appMode === "cloud") cloudFolder = event.folder || cloudFolder;
          updateSummary({
            query: event.query,
            scanned: 0,
            total: event.total,
            matched: 0,
            running: true,
          });
          setStatus(
            event.total
              ? `PDF ${event.total}개를 검색하는 중입니다…`
              : appMode === "cloud"
                ? "업로드된 PDF가 없습니다. 먼저 파일을 업로드해 주세요."
                : "검색할 PDF가 없습니다."
          );
          return;
        }

        if (event.type === "progress" || event.type === "hit") {
          updateSummary({
            query: lastQuery,
            scanned: event.scanned,
            total: event.total,
            matched: event.matched,
            unreadable: event.unreadable,
            running: true,
          });
          setStatus(
            `검색 중… (${event.scanned}/${event.total}) ${event.current || ""}`.trim()
          );
        }

        if (event.type === "hit" && event.file) {
          appendHit(event.file);
        }

        if (event.type === "done") {
          finished = true;
          lastQuery = event.query;
          resultsEl.dataset.folder = event.folder || folder;
          if (appMode === "cloud") cloudFolder = event.folder || cloudFolder;
          updateSummary({
            query: event.query,
            scanned: event.scanned,
            total: event.total,
            matched: event.matched,
            unreadable: event.unreadable,
            running: false,
          });
          if (!event.matched) showEmpty();
          setStatus(
            event.matched
              ? `검색 완료 · 일치 ${event.matched}개`
              : "검색 완료 · 일치하는 PDF가 없습니다."
          );
        }
      },
      controller.signal
    );

    if (controller.signal.aborted) {
      if (!pendingRestart) finishStopped();
    } else if (!finished) {
      updateSummary({ ...lastSummary, running: false });
      if (!hitCount) showEmpty();
      setStatus("검색 연결이 끊어졌습니다.", true);
    }
  } catch (err) {
    if (err.name === "AbortError") {
      if (!pendingRestart) finishStopped();
      return;
    }
    updateSummary({ ...lastSummary, running: false });
    setStatus(err.message || "검색에 실패했습니다.", true);
  } finally {
    if (activeSearch === controller) activeSearch = null;
    if (pendingRestart) {
      pendingRestart = false;
      setTimeout(() => startSearch(), 0);
    } else {
      setSearching(false);
    }
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  startSearch();
});

loadConfig();
keywordInput.focus();
