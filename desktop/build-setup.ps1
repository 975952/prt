[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [string]$ISCC,
    [string]$ExePath,
    [string]$OutputDir,
    [string]$Version,
    [string]$AppId = '975952.prt',
    [string]$AppName = 'prt',
    [string]$DefaultDir = '{localappdata}\Programs\prt'
)

$ErrorActionPreference = 'Stop'
$desktopRoot = $PSScriptRoot
$projectRoot = [IO.Path]::GetFullPath((Join-Path $desktopRoot '..'))
$cargoPath = Join-Path $desktopRoot 'Cargo.toml'
$cargoText = [IO.File]::ReadAllText($cargoPath, [Text.Encoding]::UTF8)
if (-not $Version) {
    $versionMatch = [regex]::Match($cargoText, '(?m)^version\s*=\s*"([^"]+)"')
    if (-not $versionMatch.Success) { throw 'Cannot read the version from desktop/Cargo.toml.' }
    $Version = $versionMatch.Groups[1].Value
}
if ($Version -notmatch '^\d+\.\d+\.\d+(?:\.\d+)?$') { throw 'The setup version must contain three or four numeric parts.' }
if (-not $ExePath) { $ExePath = Join-Path $desktopRoot 'target\release\prt.exe' }
if (-not $OutputDir) { $OutputDir = Join-Path $projectRoot 'dist' }
$ExePath = [IO.Path]::GetFullPath($ExePath)
$OutputDir = [IO.Path]::GetFullPath($OutputDir)

if (-not $ISCC) {
    $candidates = @(
        [Environment]::GetEnvironmentVariable('INNO_SETUP_COMPILER'),
        (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\Inno Setup 6\ISCC.exe')
    )
    $programFiles32 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    if ($programFiles32) { $candidates += Join-Path $programFiles32 'Inno Setup 6\ISCC.exe' }
    $programFiles64 = [Environment]::GetEnvironmentVariable('ProgramFiles')
    if ($programFiles64) { $candidates += Join-Path $programFiles64 'Inno Setup 6\ISCC.exe' }
    $onPath = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($onPath) { $candidates += $onPath.Source }
    $ISCC = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
}
if (-not $ISCC -or -not (Test-Path -LiteralPath $ISCC -PathType Leaf)) {
    throw 'Inno Setup 6 is required. Install it or pass -ISCC with the absolute path to ISCC.exe.'
}
$ISCC = [IO.Path]::GetFullPath($ISCC)

if (-not $SkipBuild) {
    Write-Host '[1/3] Building the embedded desktop application'
    (Get-Item -LiteralPath (Join-Path $desktopRoot 'src\assets.rs')).LastWriteTimeUtc = [DateTime]::UtcNow
    & cargo build --release --manifest-path $cargoPath
    if ($LASTEXITCODE -ne 0) { throw 'The Rust release build failed.' }
}
if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) { throw "Application executable does not exist: $ExePath" }
$binaryVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($ExePath).ProductVersion
if ($binaryVersion -ne $Version) {
    throw "Executable version $binaryVersion does not match setup version $Version. Rebuild or supply a matching -ExePath and -Version."
}

$defines = @{
    AppVersion = $Version
    AppId = $AppId
    AppName = $AppName
    DefaultDir = $DefaultDir
    SourceExe = $ExePath
    SetupOutputDir = $OutputDir
}
$compilerArgs = @('/Qp')
foreach ($key in $defines.Keys) {
    $value = [string]$defines[$key]
    if (-not $value -or $value.Contains('"') -or $value.Contains("`n") -or $value.Contains("`r")) {
        throw "Invalid setup parameter: $key"
    }
    $compilerArgs += "/D$key=$value"
}
$compilerArgs += Join-Path $desktopRoot 'installer\prt.iss'
[IO.Directory]::CreateDirectory($OutputDir) | Out-Null
Write-Host '[2/3] Building the per-user setup'
& $ISCC @compilerArgs
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup compilation failed.' }
$setupPath = Join-Path $OutputDir 'prt-setup.exe'
if (-not (Test-Path -LiteralPath $setupPath -PathType Leaf)) { throw 'Inno Setup did not create prt-setup.exe.' }
$hasher = [Security.Cryptography.SHA256]::Create()
try {
    $hash = [BitConverter]::ToString($hasher.ComputeHash([IO.File]::ReadAllBytes($setupPath))).Replace('-', '')
} finally {
    $hasher.Dispose()
}
Write-Host "[3/3] Ready: $setupPath"
Write-Host "Version: $Version"
Write-Host "SHA256: $hash"
