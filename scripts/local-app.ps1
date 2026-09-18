param([ValidateSet('Start', 'Stop', 'Status', 'Build')][string]$Action = 'Start')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtime = Join-Path $root 'output\local-app'
$statePath = Join-Path $runtime 'processes.json'
$receiptPath = Join-Path $runtime 'build.json'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$entry = Join-Path $PSScriptRoot 'local-runtime.mjs'
$utf8 = New-Object Text.UTF8Encoding($false)

function Save-State($Value) {
    $temporary = Join-Path $runtime 'processes.tmp.json'
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 5), $utf8)
    Move-Item -LiteralPath $temporary -Destination $statePath -Force
}

function Get-OwnedProcess($Record) {
    $process = Get-Process -Id $Record.id -ErrorAction SilentlyContinue
    if (!$process) { return $null }
    if ($process.Path -ne $node -or $process.StartTime.ToUniversalTime().Ticks.ToString() -ne $Record.started) {
        throw "Process identity changed for PID $($Record.id); refusing to stop or adopt it."
    }
    return $process
}

function Assert-PortFree([int]$Port) {
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port)
    try { $listener.Start() }
    catch { throw "Port $Port is in use. Stop the existing instance explicitly; no process was killed." }
    finally { $listener.Stop() }
}

function Wait-Ready([string]$Url, $Record) {
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if (!(Get-OwnedProcess $Record)) { throw "Service exited; inspect $runtime logs." }
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
            if ($response.StatusCode -eq 200) { return }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    throw "Readiness timed out: $Url. Inspect $runtime logs."
}

function Start-ServiceProcess([string]$Role) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $process = Start-Process -FilePath $node -ArgumentList @(('"{0}"' -f $entry), $Role) -WorkingDirectory $root -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $runtime "$stamp-$Role.out.log") -RedirectStandardError (Join-Path $runtime "$stamp-$Role.err.log")
    return @{ role = $Role; id = $process.Id; started = $process.StartTime.ToUniversalTime().Ticks.ToString() }
}

# Serialize state inspection as well as mutation; a second launch must see the first one's PIDs.
$null = New-Item -ItemType Directory -Force -Path $runtime
$lock = [IO.File]::Open((Join-Path $runtime 'launcher.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
try {
$state = $null
if (Test-Path -LiteralPath $statePath) {
    $state = Get-Content -Raw -Encoding UTF8 -LiteralPath $statePath | ConvertFrom-Json
    if ($state.root -ne $root -or $state.version -ne 1) { throw 'Unexpected local instance state; inspect it manually.' }
    if (@($state.services).Count -gt 2) { throw 'Invalid local service inventory.' }
    foreach ($record in $state.services) {
        if ($record.role -notin @('backend', 'web')) { throw 'Invalid local service role.' }
    }
}
$alive = @()
if ($state) { $alive = @($state.services | Where-Object { $null -ne (Get-OwnedProcess $_) }) }

if ($Action -eq 'Status') {
    if (!$state) { Write-Output 'No instance managed by local-app. Existing dev processes are not adopted.'; exit 0 }
    foreach ($record in $state.services) {
        Write-Output "$($record.role): PID $($record.id), running=$($null -ne (Get-OwnedProcess $record))"
    }
    Write-Output "Frontend: http://127.0.0.1:3000/`nHealth: http://127.0.0.1:3001/api/health`nData: $root\.tagent`nLogs: $runtime"
    exit 0
}

    if ($Action -eq 'Stop') {
        Write-Warning 'Stop running tasks in the UI first. Stopping a process does not undo tool actions.'
        foreach ($record in @($alive | Sort-Object role -Descending)) {
            $process = Get-OwnedProcess $record
            if ($process) { Stop-Process -InputObject $process; $process.WaitForExit(10000) | Out-Null }
        }
        if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath }
        Write-Output 'Local instance stopped. Configuration, history and logs were preserved.'
        exit 0
    }
    if ($alive.Count -gt 0) {
        if ($Action -eq 'Start' -and $alive.Count -eq 2) {
            foreach ($record in $alive) {
                $url = if ($record.role -eq 'backend') { 'http://127.0.0.1:3001/api/health' } else { 'http://127.0.0.1:3000/' }
                Wait-Ready $url $record
            }
            Write-Output 'Already running: http://127.0.0.1:3000/'; exit 0
        }
        throw 'Stop the managed local instance before building or restarting a partially running instance.'
    }
    $env:TEMP = Join-Path $root '.tmp\local-app'
    $env:TMP = $env:TEMP
    $env:NODE_COMPILE_CACHE = Join-Path $env:TEMP 'node-cache'
    $env:NEXT_TELEMETRY_DISABLED = '1'
    $null = New-Item -ItemType Directory -Force -Path $env:TEMP
    if ($Action -eq 'Build') {
        if (Test-Path -LiteralPath $receiptPath) { Remove-Item -LiteralPath $receiptPath }
        Push-Location $root
        try {
            foreach ($name in @('@tagent/ai', '@tagent/core', '@tagent/server')) {
                & pnpm --filter $name build
                if ($LASTEXITCODE -ne 0) { throw "Build failed: $name" }
            }
            & $node $entry build
            if ($LASTEXITCODE -ne 0) { throw 'Local frontend build failed.' }
            $buildId = [IO.File]::ReadAllText((Join-Path $root 'packages\tagent-web\.next-local\BUILD_ID')).Trim()
            [IO.File]::WriteAllText($receiptPath, (@{ root = $root; buildId = $buildId; createdAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json), $utf8)
        } finally { Pop-Location }
        Write-Output 'Local build ready. Run pnpm local:start.'
        exit 0
    }
    if (!(Test-Path -LiteralPath $receiptPath)) { throw 'Run pnpm local:build before starting.' }
    $receipt = Get-Content -Raw -Encoding UTF8 -LiteralPath $receiptPath | ConvertFrom-Json
    $buildId = [IO.File]::ReadAllText((Join-Path $root 'packages\tagent-web\.next-local\BUILD_ID')).Trim()
    if ($receipt.root -ne $root -or $receipt.buildId -ne $buildId) { throw 'Local build receipt does not match. Rebuild first.' }
    foreach ($port in @(3000, 3001)) { Assert-PortFree $port }
    $newState = @{ version = 1; root = $root; services = @() }
    try {
        foreach ($role in @('backend', 'web')) {
            $record = Start-ServiceProcess $role
            $newState.services += $record
            Save-State $newState
            $url = if ($role -eq 'backend') { 'http://127.0.0.1:3001/api/health' } else { 'http://127.0.0.1:3000/' }
            Wait-Ready $url $record
        }
    } catch {
        foreach ($record in $newState.services) {
            $process = Get-OwnedProcess $record
            if ($process) { Stop-Process -InputObject $process }
        }
        if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath }
        throw
    }
    Write-Output "Ready: http://127.0.0.1:3000/`nData: $root\.tagent`nLogs: $runtime`nNo model/search/email test was run."
} finally { $lock.Dispose() }
