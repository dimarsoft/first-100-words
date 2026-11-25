$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$commit = git -C $root rev-parse --short=7 HEAD
$commitDate = git -C $root show -s --format=%cI HEAD
$tag = git -C $root describe --tags --abbrev=0 2>$null

if ($LASTEXITCODE -eq 0 -and $tag -match '^v?(\d+\.\d+\.\d+)$') {
    $version = $Matches[1]
} else {
    $version = '0.1.0'
}

$metadata = [ordered]@{
    version = $version
    commit = $commit
    date = $commitDate
} | ConvertTo-Json

Set-Content -LiteralPath (Join-Path $root 'docs/git-info.json') -Value $metadata -Encoding utf8
Write-Host "Prepared docs/git-info.json for version $version ($commit, $commitDate)"
