# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Korean-language web app ("PDF 키워드 검색" / PDF keyword search) that lets a user pick a local folder in their browser and search the text of all PDFs in it (recursively) for a keyword, showing matching pages/snippets that open directly to the right page. The core design constraint: **PDF files are never uploaded to a server** — everything is read and searched client-side in the browser.

## Commands

Run locally:
```bash
python -m venv .venv
.venv\Scripts\activate      # Windows; use `source .venv/bin/activate` on Linux/macOS
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8001
```
Then open http://127.0.0.1:8001.

On Windows, `run.bat` automates venv creation, dependency install, and launch (double-click it).

There is no test suite, linter, or type-checker configured in this repo.

## Architecture

The backend (FastAPI, `app/main.py`) is intentionally minimal: it only serves the static frontend and a health check.
- `GET /` → `static/index.html`
- `GET /view` → `static/view.html` (currently just meta-redirects back to `/`; not linked from the active UI)
- `GET /api/health` → `{"ok": true, "mode": "local-folder"}` (used as `render.yaml`'s health check path)
- `/static` is mounted for `static/*` assets

**All PDF search logic runs in the browser**, in `static/app.js`:
- Folder selection uses the File System Access API (`window.showDirectoryPicker`), recursively walking directory handles for `*.pdf` files. Browsers without that API fall back to an `<input type="file" webkitdirectory multiple>` element.
- Selected `File` objects are kept in memory (`fileByPath` map, keyed by relative path) — nothing is sent to the server.
- Text extraction uses `pdf.js` loaded from a CDN (`cdnjs.cloudflare.com/.../pdf.min.mjs`) to pull per-page text content.
- Search is a regex built from the user's keyword (escaped, case-insensitive by default), matched per page, producing snippets with ~120 chars of context around each hit.
- Search runs file-by-file with a yield-to-UI pause (`setTimeout(...,0)`) between files, tracked via a `searchToken` counter so "중지" (stop) / "다시" (restart) can cancel an in-flight search cleanly.
- Clicking a result opens the PDF via `URL.createObjectURL(file)` in a new tab, jumping to the matched page via the `#page=` fragment — no navigation to `/view` or any server endpoint is involved.

**`app/pdf_search.py` is dead code from an earlier server-side architecture.** It duplicates the same snippet-extraction logic (via `pypdf`, with an mtime-based cache) for server-side searching, but nothing in `app/main.py` imports or calls it, and no route exposes it. Likewise `static/view.js` expects a `/api/pdf?path=&folder=` endpoint that does not exist in `app/main.py`. These predate the "switch to local folder picker search without uploads" change (see git log) and are not wired into the current flow — be aware of this before assuming they're live code paths.

## Deployment

Deployed to Render via `render.yaml` (Python 3.12.10 runtime, `pip install -r requirements.txt`, `uvicorn app.main:app --host 0.0.0.0 --port $PORT`). `Procfile` provides the equivalent start command for other PaaS targets. Since search is entirely client-side, the deployed server only needs to serve static files — there is no cloud/local mode branching left in the backend despite the `.env.example` mentioning `APP_MODE`/`PDF_STORAGE` (also leftovers from the earlier upload-based mode).
