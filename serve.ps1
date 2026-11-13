# ============================================================
#  Dramaweb - minimaler lokaler Webserver
#
#  Zweck: Das Spiel MUSS ueber http://localhost laufen, nicht per
#  Doppelklick auf die index.html. Unter file:// blockiert der Browser
#  Sounds und Manifest (CORS), der Service Worker laesst sich nicht
#  registrieren, und die Sprite-Umfaerbung scheitert endgueltig an
#  "canvas has been tainted by cross-origin data".
#
#  Dieses Skript braucht nur Windows-PowerShell, kein Python, kein Node.
#  Aufruf:  powershell -ExecutionPolicy Bypass -File serve.ps1 -Port 8000
# ============================================================
param(
    [int]$Port = 8000,
    [string]$Root = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'

$mime = @{
    '.html'        = 'text/html; charset=utf-8'
    '.htm'         = 'text/html; charset=utf-8'
    '.js'          = 'text/javascript; charset=utf-8'
    '.mjs'         = 'text/javascript; charset=utf-8'
    '.css'         = 'text/css; charset=utf-8'
    '.json'        = 'application/json; charset=utf-8'
    '.webmanifest' = 'application/manifest+json; charset=utf-8'
    '.png'         = 'image/png'
    '.jpg'         = 'image/jpeg'
    '.jpeg'        = 'image/jpeg'
    '.gif'         = 'image/gif'
    '.svg'         = 'image/svg+xml'
    '.ico'         = 'image/x-icon'
    '.ogg'         = 'audio/ogg'
    '.mp3'         = 'audio/mpeg'
    '.wav'         = 'audio/wav'
    '.woff'        = 'font/woff'
    '.woff2'       = 'font/woff2'
    '.ttf'         = 'font/ttf'
    '.otf'         = 'font/otf'
    '.xml'         = 'application/xml'
    '.txt'         = 'text/plain; charset=utf-8'
}

$rootFull = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")

try {
    $listener.Start()
}
catch {
    Write-Host ""
    Write-Host "Port $Port konnte nicht belegt werden: $($_.Exception.Message)"
    Write-Host "Laeuft dort schon ein Server? Dann in start-agent.bat GAME_PORT aendern."
    Write-Host ""
    Read-Host "Mit Enter beenden"
    exit 1
}

Write-Host ""
Write-Host "Dramaweb-Webserver laeuft:  http://localhost:$Port/"
Write-Host "Wurzelverzeichnis:          $rootFull"
Write-Host "Agent-Konfiguration:        http://localhost:$Port/agent/config.html"
Write-Host ""
Write-Host "Zum Beenden Strg+C druecken oder dieses Fenster schliessen."
Write-Host ""

while ($listener.IsListening) {
    try {
        $ctx = $listener.GetContext()
    }
    catch {
        break
    }

    $res = $ctx.Response
    try {
        $rel = $ctx.Request.Url.LocalPath
        if ([string]::IsNullOrEmpty($rel) -or $rel -eq '/') { $rel = '/index.html' }
        if ($rel.EndsWith('/')) { $rel = $rel + 'index.html' }
        $rel = $rel.TrimStart('/')
        $rel = $rel.Replace('/', '\')

        $target = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($rootFull, $rel))

        # Kein Ausbrechen aus dem Wurzelverzeichnis
        if (-not $target.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
            $res.StatusCode = 403
            $res.Close()
            continue
        }

        if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
            $res.StatusCode = 404
            $body = [System.Text.Encoding]::UTF8.GetBytes('404 not found')
            $res.ContentType = 'text/plain; charset=utf-8'
            $res.ContentLength64 = $body.Length
            $res.OutputStream.Write($body, 0, $body.Length)
            $res.Close()
            Write-Host ("404  " + $rel)
            continue
        }

        $ext = [System.IO.Path]::GetExtension($target).ToLowerInvariant()
        $type = $mime[$ext]
        if (-not $type) { $type = 'application/octet-stream' }

        $bytes = [System.IO.File]::ReadAllBytes($target)
        $res.ContentType = $type
        $res.ContentLength64 = $bytes.Length
        $res.Headers.Add('Cache-Control', 'no-store')
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
        $res.Close()
    }
    catch {
        try {
            $res.StatusCode = 500
            $res.Close()
        }
        catch { }
    }
}

try { $listener.Stop() } catch { }
