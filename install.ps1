$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Repository = if ($env:SYMHARIX_REPOSITORY) { $env:SYMHARIX_REPOSITORY } else { 'UniUni2000/SymHarix' }
$LocalAppData = [Environment]::GetFolderPath('LocalApplicationData')
$InstallRoot = if ($env:SYMHARIX_INSTALL_DIR) { $env:SYMHARIX_INSTALL_DIR } else { Join-Path $LocalAppData 'Programs\SymHarix' }
$BinDir = if ($env:SYMHARIX_BIN_DIR) { $env:SYMHARIX_BIN_DIR } else { Join-Path $InstallRoot 'bin' }
$SkipPrerequisites = $env:SYMHARIX_SKIP_PREREQUISITES -eq '1'
$PythonCommand = $null
$PythonArguments = @()
if (-not $SkipPrerequisites) {
  if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
    throw 'Git is required. Install Git for Windows, then rerun this installer.'
  }
  if (Get-Command python.exe -ErrorAction SilentlyContinue) {
    $PythonCommand = 'python.exe'
  } elseif (Get-Command py.exe -ErrorAction SilentlyContinue) {
    $PythonCommand = 'py.exe'
    $PythonArguments = @('-3')
  } else {
    throw 'Python 3 is required. Install Python 3 for Windows, then rerun this installer.'
  }
}

$Architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
$Arch = switch ($Architecture) {
  'x64' { 'x64' }
  'arm64' { 'arm64' }
  default { throw "Unsupported Windows architecture: $Architecture" }
}
$Asset = "symharix-windows-$Arch.zip"

if ($env:SYMHARIX_DOWNLOAD_BASE) {
  $DownloadBase = $env:SYMHARIX_DOWNLOAD_BASE.TrimEnd('/')
} elseif ($env:SYMHARIX_VERSION) {
  $ReleaseTag = if ($env:SYMHARIX_VERSION.StartsWith('v')) { $env:SYMHARIX_VERSION } else { "v$($env:SYMHARIX_VERSION)" }
  $DownloadBase = "https://github.com/$Repository/releases/download/$ReleaseTag"
} else {
  $DownloadBase = "https://github.com/$Repository/releases/latest/download"
}

$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("symharix-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TempRoot | Out-Null
try {
  $ArchivePath = Join-Path $TempRoot $Asset
  $ChecksumsPath = Join-Path $TempRoot 'checksums.txt'
  Write-Host "Downloading $Asset..."
  Invoke-WebRequest -UseBasicParsing -Uri "$DownloadBase/$Asset" -OutFile $ArchivePath
  Invoke-WebRequest -UseBasicParsing -Uri "$DownloadBase/checksums.txt" -OutFile $ChecksumsPath

  $ChecksumLine = Get-Content $ChecksumsPath | Where-Object { $_ -match "^[0-9a-fA-F]{64}\s+\*?$([Regex]::Escape($Asset))$" } | Select-Object -First 1
  if (-not $ChecksumLine) { throw "checksums.txt has no entry for $Asset" }
  $Expected = ($ChecksumLine -split '\s+')[0].ToLowerInvariant()
  $Actual = (Get-FileHash -Algorithm SHA256 -Path $ArchivePath).Hash.ToLowerInvariant()
  if ($Expected -ne $Actual) { throw "Checksum mismatch for $Asset" }

  $ExtractRoot = Join-Path $TempRoot 'extract'
  Expand-Archive -LiteralPath $ArchivePath -DestinationPath $ExtractRoot -Force
  $PackageRoot = Join-Path $ExtractRoot 'SymHarix'
  $VersionPath = Join-Path $PackageRoot 'VERSION'
  $LauncherPath = Join-Path $PackageRoot 'bin\symharix.cmd'
  if (-not (Test-Path $VersionPath) -or -not (Test-Path $LauncherPath)) {
    throw 'Release archive is incomplete.'
  }
  $Version = (Get-Content -Raw $VersionPath).Trim()
  if ($Version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') { throw "Invalid package version: $Version" }

  $VersionsDir = Join-Path $InstallRoot 'versions'
  $Destination = Join-Path $VersionsDir $Version
  New-Item -ItemType Directory -Force -Path $VersionsDir, $BinDir | Out-Null
  $ExpectedPrefix = [System.IO.Path]::GetFullPath($VersionsDir).TrimEnd('\') + '\'
  if (-not [System.IO.Path]::GetFullPath($Destination).StartsWith($ExpectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe install destination: $Destination"
  }
  if (Test-Path $Destination) { Remove-Item -Recurse -Force $Destination }
  Move-Item -LiteralPath $PackageRoot -Destination $Destination

  if (-not $SkipPrerequisites) {
    $DataHome = if ($env:SYMHARIX_HOME) { $env:SYMHARIX_HOME } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.symharix' }
    $VirtualEnv = Join-Path $DataHome '.venv'
    $VirtualEnvPython = Join-Path $VirtualEnv 'Scripts\python.exe'
    New-Item -ItemType Directory -Force -Path $DataHome | Out-Null
    if (-not (Test-Path $VirtualEnvPython)) {
      Write-Host 'Creating isolated Python environment...'
      & $PythonCommand @PythonArguments -m venv $VirtualEnv
      if ($LASTEXITCODE -ne 0) { throw 'Python could not create a virtual environment.' }
    }
    $RequirementsPath = Join-Path $Destination 'scripts\requirements.txt'
    $RequirementsDigest = (Get-FileHash -Algorithm SHA256 -Path $RequirementsPath).Hash.ToLowerInvariant()
    $RequirementsMarker = Join-Path $VirtualEnv '.symharix-requirements-sha256'
    $InstalledRequirementsDigest = if (Test-Path $RequirementsMarker) {
      (Get-Content -Raw $RequirementsMarker).Trim().ToLowerInvariant()
    } else { '' }
    if ($InstalledRequirementsDigest -ne $RequirementsDigest) {
      Write-Host 'Installing SymHarix Python runtime dependencies...'
      & $VirtualEnvPython -m pip install --disable-pip-version-check --quiet --requirement $RequirementsPath
      if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed.' }
      Set-Content -Path $RequirementsMarker -Value $RequirementsDigest -Encoding Ascii
    }
  }

  Set-Content -NoNewline -Path (Join-Path $InstallRoot 'current-version') -Value $Version

  $BatchInstallRoot = $InstallRoot.Replace('%', '%%')
  $Shim = @"
@echo off
setlocal
set "SYMHARIX_INSTALL_ROOT=$BatchInstallRoot"
set /p SYMHARIX_VERSION=<"%SYMHARIX_INSTALL_ROOT%\current-version"
call "%SYMHARIX_INSTALL_ROOT%\versions\%SYMHARIX_VERSION%\bin\symharix.cmd" %*
exit /b %ERRORLEVEL%
"@
  Set-Content -Path (Join-Path $BinDir 'symharix.cmd') -Value $Shim -Encoding Ascii

  $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $PathParts = @($UserPath -split ';' | Where-Object { $_ })
  if ($PathParts -notcontains $BinDir) {
    $NewPath = (@($PathParts) + $BinDir) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $NewPath, 'User')
    Write-Host "Added $BinDir to your user PATH. Open a new terminal to use symharix directly."
  }

  Write-Host "`nSymHarix $Version installed successfully."
  Write-Host "Command: $BinDir\symharix.cmd"
  if ($env:SYMHARIX_NO_CONFIGURE -ne '1') {
    & (Join-Path $BinDir 'symharix.cmd') configure
    exit $LASTEXITCODE
  }
  Write-Host "Next: $BinDir\symharix.cmd configure"
} finally {
  if (Test-Path $TempRoot) { Remove-Item -Recurse -Force $TempRoot }
}
