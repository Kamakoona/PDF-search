@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "VENV_PY=%~dp0.venv\Scripts\python.exe"
set "VENV_UVICORN=%~dp0.venv\Scripts\uvicorn.exe"
set "PORT=8001"
set "URL=http://127.0.0.1:%PORT%"

echo.
echo  ========================================
echo   PDF 키워드 검색 앱 시작
echo  ========================================
echo.

set "PY_CMD="
where py >nul 2>&1
if not errorlevel 1 (
  py -3 -c "import sys" >nul 2>&1
  if not errorlevel 1 set "PY_CMD=py -3"
)
if not defined PY_CMD (
  where python >nul 2>&1
  if not errorlevel 1 (
    python -c "import sys" >nul 2>&1
    if not errorlevel 1 set "PY_CMD=python"
  )
)
if not defined PY_CMD (
  echo [오류] Python 3가 설치되어 있지 않습니다.
  echo https://www.python.org/downloads/ 에서 설치 후
  echo "Add python.exe to PATH" 옵션을 켠 뒤 다시 실행해 주세요.
  pause
  exit /b 1
)

if not exist "%VENV_PY%" (
  echo [1/3] 가상환경을 만드는 중...
  %PY_CMD% -m venv .venv
  if errorlevel 1 (
    echo [오류] 가상환경 생성에 실패했습니다.
    pause
    exit /b 1
  )
)

if not exist "%VENV_UVICORN%" (
  echo [2/3] 필요한 패키지를 설치하는 중...
  "%VENV_PY%" -m pip install --upgrade pip
  if errorlevel 1 (
    echo [오류] pip 업그레이드에 실패했습니다.
    pause
    exit /b 1
  )
  "%VENV_PY%" -m pip install -r requirements.txt
  if errorlevel 1 (
    echo [오류] 패키지 설치에 실패했습니다.
    pause
    exit /b 1
  )
)

"%VENV_PY%" -c "from app.main import app" >nul 2>&1
if errorlevel 1 (
  echo [점검] 앱 모듈을 다시 설치/점검하는 중...
  "%VENV_PY%" -m pip install -r requirements.txt
  "%VENV_PY%" -c "from app.main import app"
  if errorlevel 1 (
    echo [오류] app.main 임포트에 실패했습니다. 위 메시지를 확인해 주세요.
    pause
    exit /b 1
  )
)

powershell -NoProfile -Command "try { $c = Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction Stop; if ($c) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 (
  echo 서버가 이미 실행 중입니다. 브라우저를 엽니다.
  start "" "%URL%"
  pause
  exit /b 0
)

echo [3/3] 서버를 시작합니다...
echo.
echo  주소: %URL%
echo  종료하려면 이 창에서 Ctrl+C 를 누르세요.
echo.

start "" "%URL%"
"%VENV_UVICORN%" app.main:app --host 127.0.0.1 --port %PORT%
set "ERR=%ERRORLEVEL%"

echo.
if not "%ERR%"=="0" (
  echo [오류] 서버가 비정상 종료되었습니다. 코드: %ERR%
)
echo 서버가 종료되었습니다.
pause
exit /b %ERR%
