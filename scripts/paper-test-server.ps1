# Quick Paper Server Setup for Skin Testing
# Run this script to download and launch a Paper server in offline mode

param(
    [string]$Version = "1.21.4",
    [string]$ServerDir = ".\paper-test-server"
)

$ErrorActionPreference = "Stop"

# Create server directory
if (-not (Test-Path $ServerDir)) {
    New-Item -ItemType Directory -Path $ServerDir | Out-Null
}

$jarPath = Join-Path $ServerDir "paper.jar"

# Download Paper if not already present
if (-not (Test-Path $jarPath)) {
    Write-Host "Downloading Paper $Version..." -ForegroundColor Cyan

    # Get latest build number from Paper API
    $buildsUrl = "https://api.papermc.io/v2/projects/paper/versions/$Version/builds"
    $builds = Invoke-RestMethod -Uri $buildsUrl -Headers @{ "User-Agent" = "voxta-minecraft-companion" }
    $latestBuild = $builds.builds[-1]
    $buildNumber = $latestBuild.build
    $downloadName = $latestBuild.downloads.application.name

    Write-Host "Latest build: #$buildNumber ($downloadName)" -ForegroundColor Green

    $downloadUrl = "https://api.papermc.io/v2/projects/paper/versions/$Version/builds/$buildNumber/downloads/$downloadName"
    Write-Host "Downloading from: $downloadUrl"
    Invoke-WebRequest -Uri $downloadUrl -OutFile $jarPath -Headers @{ "User-Agent" = "voxta-minecraft-companion" }
    Write-Host "Downloaded Paper to $jarPath" -ForegroundColor Green
} else {
    Write-Host "Paper jar already exists at $jarPath" -ForegroundColor Yellow
}

# Accept EULA
$eulaPath = Join-Path $ServerDir "eula.txt"
Set-Content -Path $eulaPath -Value "eula=true"
Write-Host "EULA accepted" -ForegroundColor Green

# Configure server.properties for offline mode
$propsPath = Join-Path $ServerDir "server.properties"
$props = @"
online-mode=false
server-port=25565
gamemode=creative
difficulty=peaceful
spawn-monsters=false
spawn-animals=true
level-type=minecraft\:flat
max-players=5
motd=Voxta Skin Test Server
enable-command-block=true
"@
Set-Content -Path $propsPath -Value $props
Write-Host "Server configured (offline-mode=false, creative, flat world)" -ForegroundColor Green

# Launch server
Write-Host ""
Write-Host "Starting Paper server..." -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop" -ForegroundColor Yellow
Write-Host ""

Push-Location $ServerDir
try {
    java -Xmx1G -jar paper.jar --nogui
} finally {
    Pop-Location
}
