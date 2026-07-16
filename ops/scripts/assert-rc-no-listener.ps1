<#
.SYNOPSIS
  I4 negative-test harness for ADR-018 R1 (ticket t-1783198032014).

  Asserts that enabling `claude remote-control` opens NO new listening socket
  on any interface (the documented behavior is outbound-only HTTPS polling).

.DESCRIPTION
  Two modes, one re-runnable script (Windows PowerShell 5.1 compatible):

  1) SNAPSHOT mode (default):
       .\assert-rc-no-listener.ps1 -Label before
     Captures every TCP listening socket (all interfaces, with owning process
     names) plus all bound UDP endpoints (informational), and writes a
     timestamped JSON snapshot under ops\outputs\.

  2) DIFF mode:
       .\assert-rc-no-listener.ps1 -Before <before.json> -After <after.json>
     Compares two snapshots. FAILS LOUD (exit 1) if any TCP listening socket
     (LocalAddress:LocalPort) exists in the after-snapshot that was not in the
     before-snapshot. New UDP endpoints are reported as WARN only (UDP has no
     LISTEN state and ephemeral churn is normal), escalated in the report when
     the owning process looks like claude/node.

.NOTES
  Read-only against the system: it only reads socket tables and writes its own
  snapshot files under ops\outputs\. Run the before-snapshot BEFORE the first
  `claude remote-control` opt-in, the after-snapshot while Remote Control is
  connected, then the diff. Attach the diff output to the ticket.
#>

[CmdletBinding(DefaultParameterSetName = "Snapshot")]
param(
    [Parameter(ParameterSetName = "Snapshot")]
    [string]$Label = "snapshot",

    [Parameter(ParameterSetName = "Diff", Mandatory = $true)]
    [string]$Before,

    [Parameter(ParameterSetName = "Diff", Mandatory = $true)]
    [string]$After,

    [string]$OutDir
)

$ErrorActionPreference = "Stop"

# Resolve output dir relative to this script: ops\scripts -> repo root -> ops\outputs
if (-not $OutDir) {
    $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $OutDir = Join-Path $repoRoot "ops\outputs"
}
if (-not (Test-Path $OutDir)) {
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
}

function Get-ProcName {
    param([int]$ProcId)
    try {
        $p = Get-Process -Id $ProcId -ErrorAction Stop
        return $p.ProcessName
    } catch {
        return "unknown"
    }
}

function Get-SocketSnapshot {
    $tcp = @()
    Get-NetTCPConnection -State Listen -ErrorAction Stop | ForEach-Object {
        $tcp += [pscustomobject]@{
            LocalAddress = [string]$_.LocalAddress
            LocalPort    = [int]$_.LocalPort
            OwningPid    = [int]$_.OwningProcess
            ProcessName  = (Get-ProcName -ProcId $_.OwningProcess)
        }
    }
    $udp = @()
    try {
        Get-NetUDPEndpoint -ErrorAction Stop | ForEach-Object {
            $udp += [pscustomobject]@{
                LocalAddress = [string]$_.LocalAddress
                LocalPort    = [int]$_.LocalPort
                OwningPid    = [int]$_.OwningProcess
                ProcessName  = (Get-ProcName -ProcId $_.OwningProcess)
            }
        }
    } catch {
        Write-Warning "Could not enumerate UDP endpoints: $($_.Exception.Message)"
    }
    return [pscustomobject]@{
        meta = [pscustomobject]@{
            host      = $env:COMPUTERNAME
            capturedAt = (Get-Date).ToString("yyyy-MM-ddTHH:mm:sszzz")
            tool      = "assert-rc-no-listener.ps1"
            purpose   = "ADR-018 R1 invariant I4: claude remote-control opens no new listening socket (t-1783198032014)"
        }
        tcp = $tcp
        udp = $udp
    }
}

function TcpKey { param($e) return ("{0}:{1}" -f $e.LocalAddress, $e.LocalPort) }

if ($PSCmdlet.ParameterSetName -eq "Snapshot") {
    $snap = Get-SocketSnapshot
    $stamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
    $safeLabel = ($Label -replace "[^A-Za-z0-9_-]", "-")
    $file = Join-Path $OutDir ("rc-listeners-{0}-{1}.json" -f $safeLabel, $stamp)
    $snap | ConvertTo-Json -Depth 5 | Out-File -FilePath $file -Encoding utf8
    Write-Host ("[SNAPSHOT] {0} TCP listeners, {1} UDP endpoints captured." -f @($snap.tcp).Count, @($snap.udp).Count)
    Write-Host ("[SNAPSHOT] Written: {0}" -f $file)
    exit 0
}

# ---- DIFF mode ----
foreach ($f in @($Before, $After)) {
    if (-not (Test-Path $f)) {
        Write-Host ("[FAIL] Snapshot file not found: {0}" -f $f) -ForegroundColor Red
        exit 2
    }
}
$beforeSnap = Get-Content -Path $Before -Raw | ConvertFrom-Json
$afterSnap  = Get-Content -Path $After  -Raw | ConvertFrom-Json

Write-Host ("[DIFF] before: {0} (captured {1})" -f $Before, $beforeSnap.meta.capturedAt)
Write-Host ("[DIFF] after : {0} (captured {1})" -f $After, $afterSnap.meta.capturedAt)

$beforeTcpKeys = @{}
foreach ($e in @($beforeSnap.tcp)) { $beforeTcpKeys[(TcpKey $e)] = $e }

$newTcp = @()
foreach ($e in @($afterSnap.tcp)) {
    if (-not $beforeTcpKeys.ContainsKey((TcpKey $e))) { $newTcp += $e }
}

# Same port, different owning process (not a NEW socket, but worth eyes on it).
$repossessed = @()
foreach ($e in @($afterSnap.tcp)) {
    $k = TcpKey $e
    if ($beforeTcpKeys.ContainsKey($k)) {
        $prev = $beforeTcpKeys[$k]
        if ($prev.ProcessName -ne $e.ProcessName) { $repossessed += [pscustomobject]@{ Key = $k; Was = $prev.ProcessName; Now = $e.ProcessName } }
    }
}

$beforeUdpKeys = @{}
foreach ($e in @($beforeSnap.udp)) { $beforeUdpKeys[(TcpKey $e)] = $true }
$newUdp = @()
foreach ($e in @($afterSnap.udp)) {
    if (-not $beforeUdpKeys.ContainsKey((TcpKey $e))) { $newUdp += $e }
}

if (@($newUdp).Count -gt 0) {
    Write-Host ("[WARN] {0} new UDP endpoint(s) since the before-snapshot (informational; UDP churn is normal):" -f @($newUdp).Count) -ForegroundColor Yellow
    foreach ($e in $newUdp) {
        $line = ("       {0}:{1}  pid={2}  proc={3}" -f $e.LocalAddress, $e.LocalPort, $e.OwningPid, $e.ProcessName)
        if ($e.ProcessName -match "claude|node") {
            Write-Host ($line + "   <-- owned by a claude/node process; INVESTIGATE") -ForegroundColor Yellow
        } else {
            Write-Host $line
        }
    }
}

if (@($repossessed).Count -gt 0) {
    Write-Host "[WARN] Existing listening port(s) changed owning process (not new sockets):" -ForegroundColor Yellow
    foreach ($r in $repossessed) { Write-Host ("       {0}: was {1}, now {2}" -f $r.Key, $r.Was, $r.Now) }
}

if (@($newTcp).Count -gt 0) {
    Write-Host ""
    Write-Host ("[FAIL] I4 VIOLATED: {0} NEW TCP LISTENING SOCKET(S) appeared after the before-snapshot:" -f @($newTcp).Count) -ForegroundColor Red
    foreach ($e in $newTcp) {
        Write-Host ("       {0}:{1}  pid={2}  proc={3}" -f $e.LocalAddress, $e.LocalPort, $e.OwningPid, $e.ProcessName) -ForegroundColor Red
    }
    Write-Host "[FAIL] Remote Control is documented as outbound-only HTTPS polling; a new listener is a gate violation." -ForegroundColor Red
    Write-Host "[FAIL] Record this result on ticket t-1783198032014 and DO NOT proceed with the release." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "[PASS] I4 holds: no new TCP listening socket on any interface between the two snapshots." -ForegroundColor Green
Write-Host "[PASS] Record this result on ticket t-1783198032014 (attach this output)."
exit 0
