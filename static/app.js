import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.8.69/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.8.69/pdf.worker.min.mjs";

const form = document.getElementById("search-form");
const folderDisplay = document.getElementById("folder-display");
const folderHint = document.getElementById("folder-hint");
const pickFolderBtn = document.getElementById("pick-folder-btn");
const folderFallback = document.getElementById("folder-fallback");
const keywordInput = document.getElementById("keyword");
const caseInput = document.getElementById("case-sensitive");
const searchBtn = document.getElementById("search-btn");
const stopBtn = document.getElementById("stop-btn");
const restartBtn = document.getElementById("restart-btn");
const statusEl = document.getElementById("status");
const summaryEl = document.getElementById("summary");
const resultsEl = document.getElementById("results");

const CONTEXT_CHARS = 120;
const MAX_SNIPPETS = 40;

/** @type {{ name: string, files: { relativePath: string, file: File }[] } | null} */
let selectedFolder = null;
/** @type {Map<string, File>} */
const fileByPath = new Map();

let searchToken = 0;
let searching = false;
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
  searching = isSearching;
  searchBtn.disabled = isSearching;
  stopBtn.disabled = !isSearching;
  restartBtn.disabled = !isSearching;
  pickFolderBtn.disabled = isSearching;
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

function updateSummary({ query, scanned, total, matched, unreadable, running }) {
  lastSummary = {
    query: query ?? lastSummary.query,
    scanned: scanned ?? lastSummary.scanned,
    total: total !== undefined ? total : lastSummary.total,
    matched: matched ?? lastSummary.matched,
    unreadable: unreadable ?? lastSummary.unreadable,
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

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function findSnippets(pageText, pageNo, pattern) {
  const snippets = [];
  for (const match of pageText.matchAll(pattern)) {
    const start = Math.max(0, match.index - CONTEXT_CHARS);
    const end = Math.min(pageText.length, match.index + match[0].length + CONTEXT_CHARS);
    const chunk = pageText.slice(start, end);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < pageText.length ? "…" : "";
    const display = `${prefix}${chunk}${suffix}`;
    const offset = prefix.length - start;
    snippets.push({
      page: pageNo,
      text: display,
      matchStart: match.index + offset,
      matchEnd: match.index + match[0].length + offset,
    });
    if (snippets.length >= MAX_SNIPPETS) break;
  }
  return snippets;
}

async function extractPages(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = normalizeText(content.items.map((item) => item.str || "").join(" "));
    pages.push({ page: i, text });
  }
  return pages;
}

async function scanFile(entry, pattern) {
  try {
    const pages = await extractPages(entry.file);
    let matchCount = 0;
    const snippets = [];
    for (const { page, text } of pages) {
      if (!text) continue;
      const matches = [...text.matchAll(pattern)];
      if (!matches.length) continue;
      matchCount += matches.length;
      if (snippets.length < MAX_SNIPPETS) {
        const remain = MAX_SNIPPETS - snippets.length;
        snippets.push(...findSnippets(text, page, pattern).slice(0, remain));
      }
    }
    if (matchCount <= 0) return { hit: null, failed: false };
    return {
      hit: {
        name: entry.file.name,
        path: entry.relativePath,
        pageCount: pages.length,
        matchCount,
        snippets,
      },
      failed: false,
    };
  } catch {
    return { hit: null, failed: true };
  }
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
  if (hitCount > 0) setStatus(`검색 중지 · 지금까지 일치 ${hitCount}개`);
  else {
    setStatus("검색을 중지했습니다.");
    showEmpty();
  }
}

function openPdf(relativePath, page, name) {
  const file = fileByPath.get(relativePath);
  if (!file) {
    setStatus("파일을 찾을 수 없습니다. 폴더를 다시 선택해 주세요.", true);
    return;
  }
  const blobUrl = URL.createObjectURL(file);
  const win = window.open(`${blobUrl}#page=${page || 1}`, "_blank");
  if (!win) {
    setStatus("팝업이 차단되었습니다. 브라우저에서 팝업을 허용해 주세요.", true);
    URL.revokeObjectURL(blobUrl);
    return;
  }
  // 탭이 열린 뒤에도 blob을 유지. 너무 오래 남지 않도록 지연 해제
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  void name;
}

async function collectFromDirectoryHandle(dirHandle, prefix = "") {
  const files = [];
  for await (const entry of dirHandle.values()) {
    if (entry.kind === "file" && entry.name.toLowerCase().endsWith(".pdf")) {
      const file = await entry.getFile();
      files.push({ relativePath: `${prefix}${entry.name}`, file });
    } else if (entry.kind === "directory") {
      const nested = await collectFromDirectoryHandle(entry, `${prefix}${entry.name}/`);
      files.push(...nested);
    }
  }
  return files;
}

function collectFromFileList(fileList) {
  const files = [];
  for (const file of fileList) {
    if (!file.name.toLowerCase().endsWith(".pdf")) continue;
    const relativePath = file.webkitRelativePath || file.name;
    files.push({ relativePath, file });
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath, "ko"));
}

function applyFolderSelection(name, files) {
  selectedFolder = { name, files };
  fileByPath.clear();
  for (const entry of files) fileByPath.set(entry.relativePath, entry.file);
  folderDisplay.value = `${name}  (${files.length}개 PDF)`;
  folderHint.textContent = files.length
    ? `「${name}」폴더와 하위 폴더에서 PDF ${files.length}개를 찾았습니다.`
    : `「${name}」폴더에서 PDF를 찾지 못했습니다.`;
}

async function pickFolderWithApi() {
  if (!window.showDirectoryPicker) {
    folderFallback.click();
    return;
  }
  try {
    const dirHandle = await window.showDirectoryPicker({ mode: "read" });
    setStatus("폴더에서 PDF를 모으는 중…");
    const files = await collectFromDirectoryHandle(dirHandle);
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath, "ko"));
    applyFolderSelection(dirHandle.name, files);
    setStatus(files.length ? `폴더 선택 완료 · PDF ${files.length}개` : "선택한 폴더에 PDF가 없습니다.");
  } catch (err) {
    if (err?.name === "AbortError") return;
    // API 실패 시 탐색기(webkitdirectory)로 대체
    folderFallback.click();
  }
}

pickFolderBtn.addEventListener("click", () => {
  pickFolderWithApi();
});

folderFallback.addEventListener("change", () => {
  const list = folderFallback.files;
  if (!list?.length) return;
  const files = collectFromFileList(list);
  const top = files[0]?.relativePath?.split(/[/\\]/)[0] || "선택한 폴더";
  applyFolderSelection(top, files);
  setStatus(files.length ? `폴더 선택 완료 · PDF ${files.length}개` : "선택한 폴더에 PDF가 없습니다.");
  folderFallback.value = "";
});

resultsEl.addEventListener("click", (event) => {
  const target = event.target.closest("[data-open-pdf]");
  if (!target) return;
  openPdf(target.dataset.path, Number.parseInt(target.dataset.page || "1", 10) || 1, target.dataset.name || "");
});

stopBtn.addEventListener("click", () => {
  if (!searching) return;
  pendingRestart = false;
  searchToken += 1;
});

restartBtn.addEventListener("click", () => {
  if (!searching) return;
  pendingRestart = true;
  searchToken += 1;
});

async function startSearch() {
  const keyword = keywordInput.value.trim();
  if (!keyword) return;
  if (!selectedFolder?.files?.length) {
    setStatus("먼저 탐색기에서 PDF 폴더를 선택해 주세요.", true);
    return;
  }

  const token = ++searchToken;
  pendingRestart = false;
  setSearching(true);
  hitCount = 0;
  lastSummary = { query: keyword, scanned: 0, total: selectedFolder.files.length, matched: 0, unreadable: 0 };
  resultsEl.innerHTML = "";
  setStatus(`PDF ${selectedFolder.files.length}개를 검색하는 중입니다…`);
  updateSummary({ query: keyword, scanned: 0, total: selectedFolder.files.length, matched: 0, running: true });

  const flags = caseInput.checked ? "g" : "gi";
  const pattern = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);

  let scanned = 0;
  let matched = 0;
  let unreadable = 0;
  let stopped = false;

  try {
    for (const entry of selectedFolder.files) {
      if (token !== searchToken) {
        stopped = true;
        break;
      }
      scanned += 1;
      setStatus(`검색 중… (${scanned}/${selectedFolder.files.length}) ${entry.relativePath}`);
      updateSummary({
        query: keyword,
        scanned,
        total: selectedFolder.files.length,
        matched,
        unreadable,
        running: true,
      });

      const { hit, failed } = await scanFile(entry, pattern);
      if (token !== searchToken) {
        stopped = true;
        break;
      }
      if (failed) {
        unreadable += 1;
        continue;
      }
      if (hit) {
        matched += 1;
        appendHit(hit);
        updateSummary({
          query: keyword,
          scanned,
          total: selectedFolder.files.length,
          matched,
          unreadable,
          running: true,
        });
      }
      // UI 갱신을 위해 잠깐 양보
      await new Promise((r) => setTimeout(r, 0));
    }

    if (stopped) {
      if (pendingRestart) {
        pendingRestart = false;
        setSearching(false);
        setTimeout(() => startSearch(), 0);
        return;
      }
      finishStopped();
      return;
    }

    updateSummary({
      query: keyword,
      scanned,
      total: selectedFolder.files.length,
      matched,
      unreadable,
      running: false,
    });
    if (!matched) showEmpty();
    setStatus(matched ? `검색 완료 · 일치 ${matched}개` : "검색 완료 · 일치하는 PDF가 없습니다.");
  } catch (err) {
    updateSummary({ ...lastSummary, running: false });
    setStatus(err.message || "검색에 실패했습니다.", true);
  } finally {
    if (token === searchToken || !pendingRestart) setSearching(false);
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  startSearch();
});

keywordInput.focus();
