@echo off
REM ============================================================
REM  Dramaweb Agent - Startskript
REM  Startet (optional) den lokalen llama-server und einen
REM  lokalen Webserver fuer das Spiel, dann oeffnet es den Browser.
REM
REM  WICHTIG: Das Spiel immer ueber http://localhost starten, nicht
REM  per Doppelklick auf die index.html. Unter file:// fehlen dem
REM  Spiel Service Worker und Speicher, und bei lokalem llama-server
REM  wuerde die https-Adresse von GitHub Pages den Zugriff auf
REM  localhost als Mixed Content blockieren.
REM ============================================================

REM ---- 1 = lokaler llama-server, 0 = kein lokales LLM (z.B. OpenRouter) ----
set USE_LOCAL_LLM=1

REM ---- Anpassen: Pfad zu llama-server.exe und zum Modell ----
set LLAMA_SERVER=C:\llama\llama-server.exe
set MODEL=C:\llama\models\qwen.gguf
set LLAMA_PORT=8080
set GPU_LAYERS=999
set CTX=8192

REM ---- Anpassen: Port fuer das Spiel ----
set GAME_PORT=8000

if "%USE_LOCAL_LLM%"=="1" (
    echo Starte llama-server auf Port %LLAMA_PORT% ...
    start "llama-server" "%LLAMA_SERVER%" -m "%MODEL%" --port %LLAMA_PORT% -ngl %GPU_LAYERS% -c %CTX% --host 127.0.0.1
) else (
    echo Lokales LLM uebersprungen, Anbieter wird in der Agent-Config gesetzt.
)

echo Starte lokalen Webserver fuer das Spiel auf Port %GAME_PORT% ...
start "dramaweb-web" cmd /c "cd /d %~dp0 && python -m http.server %GAME_PORT%"

echo Warte auf den Start der Server ...
timeout /t 4 /nobreak >nul

echo Oeffne das Spiel im Browser ...
start "" "http://localhost:%GAME_PORT%/index.html"

echo.
echo Fertig. Agent-Config: http://localhost:%GAME_PORT%/agent/config.html
echo Im Spiel unten links auf Start druecken.
echo Dieses Fenster kann offen bleiben.
pause
