from __future__ import annotations

import re
import threading
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pypdf import PdfReader

# 파일 mtime 기준 간단 캐시 (같은 PDF를 반복 검색할 때 속도 향상)
_cache_lock = threading.Lock()
_text_cache: dict[str, tuple[float, list[tuple[int, str]]]] = {}

CONTEXT_CHARS = 120
MAX_SNIPPETS_PER_FILE = 40


@dataclass
class Snippet:
    page: int
    text: str
    match_start: int
    match_end: int


@dataclass
class FileHit:
    name: str
    path: str
    page_count: int
    match_count: int
    snippets: list[Snippet]


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def _extract_pages(pdf_path: Path) -> list[tuple[int, str]]:
    key = str(pdf_path.resolve())
    try:
        mtime = pdf_path.stat().st_mtime
    except OSError:
        return []

    with _cache_lock:
        cached = _text_cache.get(key)
        if cached and cached[0] == mtime:
            return cached[1]

    pages: list[tuple[int, str]] = []
    try:
        reader = PdfReader(str(pdf_path))
        for idx, page in enumerate(reader.pages, start=1):
            try:
                raw = page.extract_text() or ""
            except Exception:  # noqa: BLE001
                raw = ""
            pages.append((idx, _normalize(raw)))
    except Exception:  # noqa: BLE001
        return []

    with _cache_lock:
        _text_cache[key] = (mtime, pages)
        if len(_text_cache) > 200:
            oldest = next(iter(_text_cache))
            _text_cache.pop(oldest, None)

    return pages


def _find_snippets(page_text: str, page_no: int, pattern: re.Pattern[str]) -> list[Snippet]:
    snippets: list[Snippet] = []
    for match in pattern.finditer(page_text):
        start = max(0, match.start() - CONTEXT_CHARS)
        end = min(len(page_text), match.end() + CONTEXT_CHARS)
        chunk = page_text[start:end]
        prefix = "…" if start > 0 else ""
        suffix = "…" if end < len(page_text) else ""
        display = f"{prefix}{chunk}{suffix}"
        offset = len(prefix) - start
        snippets.append(
            Snippet(
                page=page_no,
                text=display,
                match_start=match.start() + offset,
                match_end=match.end() + offset,
            )
        )
        if len(snippets) >= MAX_SNIPPETS_PER_FILE:
            break
    return snippets


def list_pdfs(folder: Path, recursive: bool = True) -> list[Path]:
    if recursive:
        return sorted(folder.rglob("*.pdf"), key=lambda p: p.name.lower())
    return sorted(folder.glob("*.pdf"), key=lambda p: p.name.lower())


def _hit_to_dict(hit: FileHit) -> dict[str, Any]:
    return {
        "name": hit.name,
        "path": hit.path,
        "pageCount": hit.page_count,
        "matchCount": hit.match_count,
        "snippets": [
            {
                "page": s.page,
                "text": s.text,
                "matchStart": s.match_start,
                "matchEnd": s.match_end,
            }
            for s in hit.snippets
        ],
    }


def _scan_one(pdf: Path, pattern: re.Pattern[str]) -> tuple[FileHit | None, bool]:
    """한 파일을 검색한다. (히트 또는 None, 읽기실패 여부)"""
    pages = _extract_pages(pdf)
    if not pages:
        return None, True

    file_snippets: list[Snippet] = []
    match_count = 0
    for page_no, text in pages:
        if not text:
            continue
        page_matches = list(pattern.finditer(text))
        if not page_matches:
            continue
        match_count += len(page_matches)
        if len(file_snippets) < MAX_SNIPPETS_PER_FILE:
            remaining = MAX_SNIPPETS_PER_FILE - len(file_snippets)
            file_snippets.extend(_find_snippets(text, page_no, pattern)[:remaining])

    if match_count <= 0:
        return None, False

    return (
        FileHit(
            name=pdf.name,
            path=str(pdf.resolve()),
            page_count=len(pages),
            match_count=match_count,
            snippets=file_snippets,
        ),
        False,
    )


def iter_search_pdfs(
    folder: str | Path,
    keyword: str,
    *,
    recursive: bool = True,
    case_sensitive: bool = False,
) -> Iterator[dict[str, Any]]:
    """파일 단위로 검색하며 이벤트를 순서대로 내보낸다."""
    query = (keyword or "").strip()
    if not query:
        raise ValueError("검색어를 입력해 주세요.")

    root = Path(folder).expanduser()
    if not root.exists():
        raise FileNotFoundError(f"폴더를 찾을 수 없습니다: {root}")
    if not root.is_dir():
        raise NotADirectoryError(f"폴더가 아닙니다: {root}")

    flags = 0 if case_sensitive else re.IGNORECASE
    pattern = re.compile(re.escape(query), flags)
    resolved = str(root.resolve())
    pdfs = list_pdfs(root, recursive=recursive)

    yield {
        "type": "start",
        "query": query,
        "folder": resolved,
        "total": len(pdfs),
    }

    scanned = 0
    matched = 0
    unreadable: list[str] = []

    for pdf in pdfs:
        scanned += 1
        hit, failed = _scan_one(pdf, pattern)
        if failed:
            unreadable.append(pdf.name)
            yield {
                "type": "progress",
                "scanned": scanned,
                "total": len(pdfs),
                "matched": matched,
                "current": pdf.name,
                "unreadable": len(unreadable),
            }
            continue

        if hit is None:
            yield {
                "type": "progress",
                "scanned": scanned,
                "total": len(pdfs),
                "matched": matched,
                "current": pdf.name,
                "unreadable": len(unreadable),
            }
            continue

        matched += 1
        yield {
            "type": "hit",
            "scanned": scanned,
            "total": len(pdfs),
            "matched": matched,
            "current": pdf.name,
            "unreadable": len(unreadable),
            "file": _hit_to_dict(hit),
        }

    yield {
        "type": "done",
        "query": query,
        "folder": resolved,
        "scanned": scanned,
        "total": len(pdfs),
        "matched": matched,
        "unreadable": unreadable,
    }


def search_pdfs(
    folder: str | Path,
    keyword: str,
    *,
    recursive: bool = True,
    case_sensitive: bool = False,
) -> dict:
    """전체 검색 후 한 번에 결과를 반환한다."""
    query = ""
    folder_path = ""
    scanned = 0
    matched = 0
    unreadable: list[str] = []
    files: list[dict[str, Any]] = []

    for event in iter_search_pdfs(
        folder,
        keyword,
        recursive=recursive,
        case_sensitive=case_sensitive,
    ):
        kind = event["type"]
        if kind == "start":
            query = event["query"]
            folder_path = event["folder"]
        elif kind == "hit":
            files.append(event["file"])
        elif kind == "done":
            scanned = event["scanned"]
            matched = event["matched"]
            unreadable = event["unreadable"]
            query = event["query"]
            folder_path = event["folder"]

    files.sort(key=lambda f: (-f["matchCount"], f["name"].lower()))
    return {
        "query": query,
        "folder": folder_path,
        "scanned": scanned,
        "matched": matched,
        "unreadable": unreadable,
        "files": files,
    }
