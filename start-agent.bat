@echo off
REM ============================================================
REM  Dramaweb Agent - Startskript
REM  Startet den lokalen llama-server und einen lokalen Webserver
REM  fuer das Spiel und oeffnet den Browser.
REM
REM  WICHTIG: Das Spiel muss lokal ueber http laufen (nicht ueber
REM  die GitHub-Pages-https-Adresse), sonst blockiert der Browser
REM  den Zugriff auf den llama-server (Mixed Content).
REM ============================================================

REM ---- Anpassen: Pfad zu llama-server.exe und zum Modell ----
set LLAMA_SERVER=C:\llama\llama-server.exe
set MODEL=C:\llama\models\qwen.gguf
set LLAMA_PORT=8080
set GPU_LAYERS=999
set CTX=8192

REM ---- Anpassen: Port fuer das Spiel ----
set GAME_PORT=8000

echo Starte llama-server auf Port %LLAMA_PORT% ...
start "llama-server" "%LLAMA_SERVER%" -m "%MODEL%" --port %LLAMA_PORT% -ngl %GPU_LAYERS% -c %CTX% --host 127.0.0.1

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
