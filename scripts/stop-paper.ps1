<#
.SYNOPSIS
    Kill the Paper test server (all Java processes).
#>

$javaProcs = Get-Process -Name "java" -ErrorAction SilentlyContinue
if ($javaProcs) {
    $javaProcs | Stop-Process -Force
    Write-Host "Stopped $($javaProcs.Count) Java process(es)" -ForegroundColor Yellow
} else {
    Write-Host "No Java processes found" -ForegroundColor Gray
}
