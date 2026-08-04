const params = new URLSearchParams(window.location.search);
const path = params.get("path") || "";
const folder = params.get("folder") || "";
const name = params.get("name") || path.split(/[/\\]/).pop() || "PDF";
let page = Math.max(1, Number.parseInt(params.get("page") || "1", 10) || 1);

const titleEl = document.getElementById("viewer-title");
const subEl = document.getElementById("viewer-sub");
const frame = document.getElementById("pdf-frame");
const errorEl = document.getElementById("viewer-error");
const pageInput = document.getElementById("page-input");
const openRaw = document.getElementById("open-raw");
const prevBtn = document.getElementById("prev-page");
const nextBtn = document.getElementById("next-page");

titleEl.textContent = name;
document.title = `${name} · PDF 보기`;
subEl.textContent = path;
pageInput.value = String(page);

function pdfUrl(targetPage) {
  const q = new URLSearchParams({ path, folder });
  return `/api/pdf?${q.toString()}#page=${targetPage}`;
}

function showError(message) {
  frame.hidden = true;
  errorEl.hidden = false;
  errorEl.textContent = message;
}

function loadPage(targetPage) {
  if (!path || !folder) {
    showError("파일 정보가 없습니다. 검색 결과에서 다시 열어 주세요.");
    return;
  }
  page = Math.max(1, targetPage);
  pageInput.value = String(page);
  const url = pdfUrl(page);
  frame.hidden = false;
  errorEl.hidden = true;
  // 같은 문서에서 페이지만 바꿀 때도 브라우저가 해시를 반영하도록 재할당
  frame.src = url;
  openRaw.href = url;

  const nextParams = new URLSearchParams(params);
  nextParams.set("page", String(page));
  history.replaceState(null, "", `/view?${nextParams.toString()}`);
}

pageInput.addEventListener("change", () => {
  const value = Number.parseInt(pageInput.value, 10);
  if (!Number.isFinite(value) || value < 1) {
    pageInput.value = String(page);
    return;
  }
  loadPage(value);
});

prevBtn.addEventListener("click", () => loadPage(page - 1));
nextBtn.addEventListener("click", () => loadPage(page + 1));

loadPage(page);
