@echo off
REM ============================================================
REM  Dramaweb Agent - Startskript
REM
REM  WICHTIG: Immer dieses Skript benutzen, NICHT die index.html
REM  doppelklicken. Unter file:// blockiert der Browser Sounds und
REM  Manifest, der Service Worker scheitert, und die Sprite-
REM  Umfaerbung bricht mit "canvas has been tainted by cross-origin
REM  data" ab. Das Spiel braucht http://localhost.
REM ============================================================

REM ---- 1 = lokaler llama-server, 0 = kein lokales LLM (z.B. OpenRouter) ----
set USE_LOCAL_LLM=1

REM ---- Anpassen: Pfad zu llama-server.exe und zum Modell ----
set LLAMA_SERVER=C:\llama\llama-server.exe
set MODEL=C:\llama\models\qwen.gguf
set LLAMA_PORT=8080
set GPU_LAYERS=999
set CTX=8192

REM ---- Port fuer das Spiel ----
set GAME_PORT=8000

REM ---- Webserver: auto, powershell oder python ----
set WEBSERVER=auto

if "%USE_LOCAL_LLM%"=="1" (
    echo Starte llama-server auf Port %LLAMA_PORT% ...
    start "llama-server" "%LLAMA_SERVER%" -m "%MODEL%" --port %LLAMA_PORT% -ngl %GPU_LAYERS% -c %CTX% --host 127.0.0.1
) else (
    echo Lokales LLM uebersprungen, Anbieter wird in der Agent-Config gesetzt.
)

if /i not "%WEBSERVER%"=="auto" goto server_chosen
python --version >nul 2>&1
if errorlevel 1 (set WEBSERVER=powershell) else (set WEBSERVER=python)
:server_chosen

echo Starte lokalen Webserver (%WEBSERVER%) auf Port %GAME_PORT% ...
if /i "%WEBSERVER%"=="python" (
    start "dramaweb-web" cmd /c "cd /d %~dp0 && python -m http.server %GAME_PORT%"
) else (
    start "dramaweb-web" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" -Port %GAME_PORT% -Root "%~dp0"
)

echo Warte auf den Start der Server ...
timeout /t 4 /nobreak >nul

echo Oeffne das Spiel im Browser ...
start "" "http://localhost:%GAME_PORT%/index.html"

echo.
echo Fertig.
echo   Spiel:        http://localhost:%GAME_PORT%/index.html
echo   Agent-Config: http://localhost:%GAME_PORT%/agent/config.html
echo Im Spiel unten links auf Start druecken.
echo Dieses Fenster kann offen bleiben.
pause
