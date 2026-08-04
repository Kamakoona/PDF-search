from __future__ import annotations

import os
import re
import uuid
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.pdf_search import iter_search_pdfs, search_pdfs

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"
load_dotenv(BASE_DIR / ".env")

app = FastAPI(title="PDF 키워드 검색", version="1.3.0")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50MB per file
SAFE_NAME = re.compile(r"[^\w.\-가-힣()\[\] ]+", re.UNICODE)


def app_mode() -> str:
    """Render 등 클라우드에서는 cloud, 로컬은 local(기본)."""
    explicit = os.getenv("APP_MODE", "").strip().lower()
    if explicit in {"cloud", "local"}:
        return explicit
    if os.getenv("RENDER") or os.getenv("RAILWAY_ENVIRONMENT") or os.getenv("FLY_APP_NAME"):
        return "cloud"
    return "local"


def storage_dir() -> Path:
    raw = os.getenv("PDF_STORAGE", "").strip()
    path = Path(raw).expanduser() if raw else (BASE_DIR / "data" / "pdfs")
    path.mkdir(parents=True, exist_ok=True)
    return path.resolve()


def default_search_folder() -> str:
    if app_mode() == "cloud":
        return str(storage_dir())
    return os.getenv("PDF_FOLDER", "").strip()


class SearchRequest(BaseModel):
    keyword: str = Field(..., min_length=1, max_length=200)
    folder: str = Field("", description="로컬 모드에서만 사용. 클라우드에서는 무시")
    recursive: bool = True
    case_sensitive: bool = False


def _resolve_search_root(folder: str) -> Path:
    if app_mode() == "cloud":
        return storage_dir()
    folder = (folder or "").strip() or default_search_folder()
    if not folder:
        raise HTTPException(status_code=400, detail="PDF 폴더 경로를 입력해 주세요.")
    root = Path(folder).expanduser().resolve()
    if not root.exists():
        raise HTTPException(status_code=404, detail=f"폴더를 찾을 수 없습니다: {root}")
    if not root.is_dir():
        raise HTTPException(status_code=400, detail=f"폴더가 아닙니다: {root}")
    return root


def _resolve_allowed_pdf(folder: str, path: str) -> Path:
    """검색 폴더(또는 업로드 저장소) 안의 PDF만 열 수 있도록 검증한다."""
    root = _resolve_search_root(folder)
    target = Path(path).expanduser().resolve()
    try:
        target.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="허용된 폴더 밖의 파일은 열 수 없습니다.") from exc

    if target.suffix.lower() != ".pdf":
        raise HTTPException(status_code=400, detail="PDF 파일만 열 수 있습니다.")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")
    return target


def _safe_filename(name: str) -> str:
    base = Path(name or "document.pdf").name
    cleaned = SAFE_NAME.sub("_", base).strip(" ._") or "document.pdf"
    if not cleaned.lower().endswith(".pdf"):
        cleaned += ".pdf"
    return cleaned[:180]


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/view")
async def view_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "view.html")


@app.get("/api/health")
async def health() -> dict:
    return {"ok": True, "mode": app_mode()}


@app.get("/api/config")
async def config() -> dict:
    mode = app_mode()
    store = storage_dir()
    pdf_count = len(list(store.glob("*.pdf"))) if mode == "cloud" else None
    return {
        "mode": mode,
        "defaultFolder": default_search_folder(),
        "storageFolder": str(store),
        "pdfCount": pdf_count,
        "maxUploadMb": MAX_UPLOAD_BYTES // (1024 * 1024),
    }


@app.get("/api/library")
async def library() -> dict:
    """클라우드(업로드) 저장소의 PDF 목록."""
    store = storage_dir()
    files = []
    for pdf in sorted(store.glob("*.pdf"), key=lambda p: p.name.lower()):
        try:
            size = pdf.stat().st_size
        except OSError:
            size = 0
        files.append({"name": pdf.name, "path": str(pdf.resolve()), "size": size})
    return {"folder": str(store), "total": len(files), "files": files}


@app.post("/api/upload")
async def upload_pdfs(files: list[UploadFile] = File(...)) -> dict:
    """PDF를 서버 저장소에 업로드한다 (클라우드용)."""
    if not files:
        raise HTTPException(status_code=400, detail="업로드할 파일이 없습니다.")

    store = storage_dir()
    saved: list[dict] = []
    errors: list[str] = []

    for upload in files:
        original = upload.filename or "document.pdf"
        if not original.lower().endswith(".pdf"):
            errors.append(f"{original}: PDF만 업로드할 수 있습니다.")
            continue

        safe = _safe_filename(original)
        dest = store / safe
        if dest.exists():
            stem = dest.stem
            dest = store / f"{stem}_{uuid.uuid4().hex[:8]}.pdf"

        try:
            size = 0
            with dest.open("wb") as out:
                while True:
                    chunk = await upload.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > MAX_UPLOAD_BYTES:
                        out.close()
                        dest.unlink(missing_ok=True)
                        raise HTTPException(
                            status_code=400,
                            detail=f"{original}: 파일당 {MAX_UPLOAD_BYTES // (1024 * 1024)}MB까지 가능합니다.",
                        )
                    out.write(chunk)
            saved.append({"name": dest.name, "path": str(dest.resolve()), "size": size})
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{original}: {exc}")
        finally:
            await upload.close()

    return {
        "saved": saved,
        "errors": errors,
        "folder": str(store),
        "total": len(list(store.glob("*.pdf"))),
    }


@app.delete("/api/library/{name}")
async def delete_pdf(name: str) -> dict:
    store = storage_dir()
    target = (store / Path(name).name).resolve()
    try:
        target.relative_to(store)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="허용되지 않은 경로입니다.") from exc
    if target.suffix.lower() != ".pdf" or not target.is_file():
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")
    target.unlink()
    return {"ok": True, "deleted": name}


@app.get("/api/pdf")
async def serve_pdf(
    path: str = Query(..., min_length=1, description="PDF 절대 경로"),
    folder: str = Query("", description="허용된 검색 폴더(로컬). 클라우드는 생략 가능"),
) -> FileResponse:
    target = _resolve_allowed_pdf(folder, path)
    return FileResponse(
        path=target,
        media_type="application/pdf",
        filename=target.name,
        content_disposition_type="inline",
        headers={"Cache-Control": "private, max-age=60"},
    )


def _sse_search(body: SearchRequest) -> StreamingResponse:
    keyword = body.keyword.strip()
    if not keyword:
        raise HTTPException(status_code=400, detail="검색어를 입력해 주세요.")

    root = _resolve_search_root(body.folder)

    def event_gen():
        import json

        try:
            for event in iter_search_pdfs(
                root,
                keyword,
                recursive=body.recursive if app_mode() == "local" else False,
                case_sensitive=body.case_sensitive,
            ):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except FileNotFoundError as exc:
            yield f"data: {json.dumps({'type': 'error', 'detail': str(exc)}, ensure_ascii=False)}\n\n"
        except NotADirectoryError as exc:
            yield f"data: {json.dumps({'type': 'error', 'detail': str(exc)}, ensure_ascii=False)}\n\n"
        except ValueError as exc:
            yield f"data: {json.dumps({'type': 'error', 'detail': str(exc)}, ensure_ascii=False)}\n\n"
        except Exception as exc:  # noqa: BLE001
            yield f"data: {json.dumps({'type': 'error', 'detail': f'검색 실패: {exc}'}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/search/stream")
async def search_stream(body: SearchRequest) -> StreamingResponse:
    return _sse_search(body)


@app.post("/api/search")
async def search(body: SearchRequest) -> dict:
    keyword = body.keyword.strip()
    if not keyword:
        raise HTTPException(status_code=400, detail="검색어를 입력해 주세요.")

    root = _resolve_search_root(body.folder)
    try:
        return search_pdfs(
            root,
            keyword,
            recursive=body.recursive if app_mode() == "local" else False,
            case_sensitive=body.case_sensitive,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except NotADirectoryError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"검색 실패: {exc}") from exc


@app.get("/api/search")
async def search_get(
    q: str = Query(..., min_length=1, description="검색 키워드"),
    folder: str = Query("", description="PDF 폴더 경로(로컬)"),
    recursive: bool = Query(True),
    case_sensitive: bool = Query(False),
) -> dict:
    body = SearchRequest(keyword=q, folder=folder, recursive=recursive, case_sensitive=case_sensitive)
    return await search(body)
