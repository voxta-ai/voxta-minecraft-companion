<#
.SYNOPSIS
    Start the Paper test server in a new interactive window.
    Kills any existing Java processes first, then launches Paper
    in its own console window so you can type server commands directly.
.EXAMPLE
    .\scripts\start-paper.ps1
    .\scripts\start-paper.ps1 -Version "1.21.11"
#>

param(
    [string]$Version = "1.21.11",
    [string]$ServerDir = ".\paper-test-server"
)

# Kill any existing Java/Paper
$javaProcs = Get-Process -Name "java" -ErrorAction SilentlyContinue
if ($javaProcs) {
    $javaProcs | Stop-Process -Force
    Write-Host "Stopped existing Java processes" -ForegroundColor Yellow
    Start-Sleep -Seconds 1
}

# Ensure server directory exists
if (-not (Test-Path $ServerDir)) {
    New-Item -ItemType Directory -Path $ServerDir | Out-Null
}

$jarPath = Join-Path $ServerDir "paper.jar"

# Download Paper if not already present
if (-not (Test-Path $jarPath)) {
    Write-Host "Downloading Paper $Version..." -ForegroundColor Cyan
    $buildsUrl = "https://api.papermc.io/v2/projects/paper/versions/$Version/builds"
    $builds = Invoke-RestMethod -Uri $buildsUrl -Headers @{ "User-Agent" = "voxta-minecraft-companion" }
    $latestBuild = $builds.builds[-1]
    $buildNumber = $latestBuild.build
    $downloadName = $latestBuild.downloads.application.name
    Write-Host "Latest build: #$buildNumber ($downloadName)" -ForegroundColor Green
    $downloadUrl = "https://api.papermc.io/v2/projects/paper/versions/$Version/builds/$buildNumber/downloads/$downloadName"
    Invoke-WebRequest -Uri $downloadUrl -OutFile $jarPath -Headers @{ "User-Agent" = "voxta-minecraft-companion" }
    Write-Host "Downloaded Paper to $jarPath" -ForegroundColor Green
} else {
    Write-Host "Paper jar already exists" -ForegroundColor Gray
}

# Accept EULA
Set-Content -Path (Join-Path $ServerDir "eula.txt") -Value "eula=true"

# Configure server.properties
$propsPath = Join-Path $ServerDir "server.properties"
$props = @"
online-mode=false
server-port=25565
gamemode=survival
difficulty=easy
spawn-monsters=true
spawn-animals=true
level-type=minecraft\:normal
max-players=5
motd=Voxta Test Server
enable-command-block=true
"@
Set-Content -Path $propsPath -Value $props

# Pre-configure OP for Emptyngton (UUID is offline-mode UUID)
$opsPath = Join-Path $ServerDir "ops.json"
$ops = @"
[
  {
    "uuid": "20dc804b-ed2f-3055-8092-72dd788b9b23",
    "name": "Emptyngton",
    "level": 4,
    "bypassesPlayerLimit": false
  }
]
"@
Set-Content -Path $opsPath -Value $ops

Write-Host ""
Write-Host "Starting Paper server in a new window..." -ForegroundColor Cyan
Write-Host "Type server commands (op, tp, etc.) directly in that window." -ForegroundColor Green
Write-Host "Close that window or type 'stop' to shut the server down." -ForegroundColor Yellow
Write-Host ""

# Launch in a NEW window so the user gets an interactive server console
$serverFullDir = (Resolve-Path $ServerDir).Path
Start-Process pwsh -ArgumentList "-NoExit", "-Command", "Set-Location '$serverFullDir'; java -Xmx1G -jar paper.jar --nogui" -WorkingDirectory $serverFullDir

Write-Host "Server launched! Look for the new console window." -ForegroundColor Green
