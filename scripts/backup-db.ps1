<#
  backup-db.ps1 — full, restorable snapshot of the v6 production database,
  EXCLUDING the heavy track-analysis catalog (track_analyses / playlist_tracks
  / playlist_genres and the track/playlist archives). Repeatable: run it
  whenever you want a fresh point-in-time snapshot.

  What it produces (in backups/db-<timestamp>/):
    - schema.sql     Full public-schema DDL: tables, constraints, indexes,
                     RLS policies, and the v5 RPC functions. Includes the
                     track tables' STRUCTURE (cheap) — just not their data.
    - data.sql       All public-schema DATA as COPY statements, minus the
                     excluded catalog tables below.
    - auth-data.sql  auth-schema data (auth.users etc.) — this is where the
                     onboarding raw_user_meta_data.sonic blob lives. Restore
                     with care: GoTrue manages this schema.

  Restore (into an empty / rebuilt project) — in this order:
    psql "<db-url>" -f schema.sql
    psql "<db-url>" -f data.sql
    (auth-data.sql only if you specifically need the auth rows back)
  Or paste each file into the Supabase SQL Editor.

  CONNECTION — set SUPABASE_DB_URL in .env.local (gitignored) to the
  "Session pooler" connection string from:
    Supabase Dashboard -> Project Settings -> Database
      -> Connection string -> Session pooler
  Fill in your DB password. The URL must be percent-encoded (encode any
  special chars in the password). Example shape:
    SUPABASE_DB_URL="postgresql://postgres.xhkqrxljncazvbgkmqex:<PW>@aws-0-<region>.pooler.supabase.com:5432/postgres"

  Alternatively, run `supabase link --project-ref xhkqrxljncazvbgkmqex` once
  and pass -Linked to this script instead of setting SUPABASE_DB_URL.

  Usage:
    .\scripts\backup-db.ps1                 # uses SUPABASE_DB_URL from .env.local
    .\scripts\backup-db.ps1 -Linked         # uses the linked project instead
    .\scripts\backup-db.ps1 -NoAuth         # skip the auth-schema data dump
    .\scripts\backup-db.ps1 -DryRun         # print the pg_dump commands, don't run
#>

param(
  [switch]$Linked,
  [switch]$NoAuth,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# Tables whose DATA we skip (structure is still captured in schema.sql).
# Edit this list if you want to keep or drop more.
$excludeTables = @(
  'public.track_analyses',
  'public.playlist_tracks',
  'public.playlist_genres',
  'public.deleted_tracks',
  'public.deleted_playlists'
)

$repoRoot = Split-Path -Parent $PSScriptRoot

# --- Load .env.local so SUPABASE_DB_URL is available (same pattern as the
#     purge scripts) ---
$envFile = Join-Path $repoRoot '.env.local'
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([^#=]+?)\s*=\s*"?([^"]*)"?\s*$') {
      Set-Item "env:$($matches[1])" $matches[2]
    }
  }
}

# --- Resolve how we connect ---
$connArgs = @()
if ($Linked) {
  $connArgs = @('--linked')
} elseif ($env:SUPABASE_DB_URL) {
  $connArgs = @('--db-url', $env:SUPABASE_DB_URL)
} else {
  Write-Host "ERROR: no connection configured." -ForegroundColor Red
  Write-Host "Set SUPABASE_DB_URL in .env.local (Session pooler string from the"
  Write-Host "dashboard), or run 'supabase link --project-ref xhkqrxljncazvbgkmqex'"
  Write-Host "once and re-run this script with -Linked."
  exit 1
}

# --- Prepare output dir ---
$stamp   = Get-Date -Format 'yyyyMMdd-HHmmss'
$outDir  = Join-Path $repoRoot "backups\db-$stamp"
$schemaF = Join-Path $outDir 'schema.sql'
$dataF   = Join-Path $outDir 'data.sql'
$authF   = Join-Path $outDir 'auth-data.sql'

if (-not $DryRun) {
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  Write-Host "Backup dir: $outDir" -ForegroundColor Cyan
}

$excludeArgs = @()
foreach ($t in $excludeTables) { $excludeArgs += @('-x', $t) }

# --- Build the three dump command arg-lists ---
$schemaCmd = @('db','dump') + $connArgs + @('-f', $schemaF)
$dataCmd   = @('db','dump') + $connArgs + @('--data-only','--use-copy') + $excludeArgs + @('-f', $dataF)
$authCmd   = @('db','dump') + $connArgs + @('--data-only','--use-copy','-s','auth','-f', $authF)

function Invoke-Dump([string]$label, [string[]]$dumpArgs, [string]$file) {
  if ($DryRun) { $dumpArgs = $dumpArgs + '--dry-run' }
  Write-Host ""
  Write-Host "==> $label" -ForegroundColor Yellow
  # Redact any --db-url value before printing so the password never hits logs.
  $shown = @(); for ($i = 0; $i -lt $dumpArgs.Count; $i++) {
    $shown += $dumpArgs[$i]
    if ($dumpArgs[$i] -eq '--db-url') { $shown += '<redacted>'; $i++ }
  }
  Write-Host "    supabase $($shown -join ' ')"
  & supabase @dumpArgs
  if ($LASTEXITCODE -ne 0) {
    Write-Host "    FAILED ($label) exit=$LASTEXITCODE" -ForegroundColor Red
    exit $LASTEXITCODE
  }
  if (-not $DryRun -and (Test-Path $file)) {
    $kb = [math]::Round((Get-Item $file).Length / 1KB, 1)
    Write-Host "    ok -> $file ($kb KB)" -ForegroundColor Green
  }
}

Write-Host "Excluding DATA for: $($excludeTables -join ', ')" -ForegroundColor DarkGray

Invoke-Dump 'schema (DDL + RLS + functions)' $schemaCmd $schemaF
Invoke-Dump 'data (public, minus catalog)'   $dataCmd   $dataF
if (-not $NoAuth) {
  Invoke-Dump 'auth-schema data (users / metadata)' $authCmd $authF
} else {
  Write-Host "`n(skipping auth-schema dump: -NoAuth)" -ForegroundColor DarkGray
}

if (-not $DryRun) {
  Write-Host "`nDone. Snapshot saved to: $outDir" -ForegroundColor Cyan
  Write-Host "Restore order: schema.sql -> data.sql (-> auth-data.sql only if needed)."
}
