# PDF 키워드 검색

PDF 파일의 **내용**에서 키워드를 찾아, 일치하는 파일 이름과 해당 구문(페이지)을 보여 주는 웹 앱입니다.

- **로컬**: 컴퓨터의 PDF 폴더 경로를 지정해 검색
- **클라우드**: PDF를 업로드한 뒤 검색 (Render 등)

## 로컬 실행 (Windows)

`run.bat`을 더블클릭하세요.

또는:

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8001
```

브라우저: http://127.0.0.1:8001

## GitHub + Render 클라우드 배포

### 1. 코드 push
이 저장소를 GitHub에 push 합니다.

### 2. Render에서 실행
1. [https://render.com](https://render.com) 가입 (GitHub 연동)
2. **New +** → **Blueprint**
3. 이 GitHub 저장소 선택 (`render.yaml` 자동 인식)
4. **Apply** 후 배포되면 `https://xxxx.onrender.com` 으로 접속

수동 배포 시 **Web Service**로 만들고:

- Build Command: `pip install -r requirements.txt`
- Start Command: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- 환경변수: `APP_MODE=cloud`

### 클라우드 사용법
1. 페이지에서 PDF 파일을 **업로드**
2. 키워드 입력 후 **검색**
3. 결과 클릭 시 해당 페이지 열림

무료 Render 플랜은 파일이 **일시 디스크**에 저장됩니다. 서비스가 재시작되면 업로드가 사라질 수 있으니, 중요한 PDF는 다시 업로드하세요.

## 환경 변수

`.env.example` 참고:

```env
APP_MODE=local
PDF_FOLDER=C:\Users\tiger\Documents\법령PDF
PDF_STORAGE=
```

| 변수 | 설명 |
|------|------|
| `APP_MODE` | `local` 또는 `cloud` (Render에서는 기본 cloud) |
| `PDF_FOLDER` | 로컬 기본 검색 폴더 |
| `PDF_STORAGE` | 업로드 저장 경로 (기본 `./data/pdfs`) |

## 주요 기능

1. PDF 본문 키워드 검색 (스트리밍으로 결과 즉시 표시)
2. 중지 / 다시 검색
3. 결과 클릭 시 해당 페이지 보기
4. 클라우드: 다중 PDF 업로드 · 목록 · 삭제

## 참고

- 텍스트가 포함된 PDF만 검색됩니다.
- 스캔본(이미지) PDF는 검색되지 않을 수 있습니다.
