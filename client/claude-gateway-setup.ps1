# UNTESTED. This Windows PowerShell port has NOT been run: no PowerShell was available where it was written.
# The macOS/Linux script (claude-gateway-setup.sh) is the tested reference. Try this on a spare machine first, and
# if anything misbehaves use `print-managed` and deploy the JSON with your device-management tool instead.
#
# Same commands and same policy JSON as the bash script. Run from an elevated (Administrator) PowerShell for install/update/uninstall:
#   .\claude-gateway-setup.ps1 install [--gateway-url URL] [--dry-run] [--yes] [--no-user-settings] [--defaults F] [--models F] [--force-old-claude]
#   A company-stamped copy ignores defaults.json / models.json next to it and CLAUDE_GATEWAY_URL / CLAUDE_GATEWAY_MODELS unless --dev (or --allow-overrides) is given.
#   .\claude-gateway-setup.ps1 update | status | upgrade | downgrade | reset | print-managed | uninstall
#   .\claude-gateway-setup.ps1 model <name|id>      .\claude-gateway-setup.ps1 effort <low|medium|high|xhigh>
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)
$ErrorActionPreference = 'Stop'

# --- stamped by scripts/package-client.sh (these stay empty in the source tree) ---
# Values are base64 inside SINGLE quotes: PowerShell never expands or executes anything inside them.
$StampGatewayUrlB64 = ''
$StampModelsB64 = ''
$StampDefaultsB64 = ''
# --- end stamped ---

$MinVersion = [version]'2.1.285'
$Efforts = @('low', 'medium', 'high', 'xhigh')
$PinKeys = [ordered]@{ sonnet = 'ANTHROPIC_DEFAULT_SONNET_MODEL'; opus = 'ANTHROPIC_DEFAULT_OPUS_MODEL'; haiku = 'ANTHROPIC_DEFAULT_HAIKU_MODEL' }
$SysDir = if ($env:CLAUDE_MANAGED_DIR) { $env:CLAUDE_MANAGED_DIR } else { Join-Path $env:ProgramFiles 'ClaudeCode' }
$UserDir = if ($env:CLAUDE_USER_DIR) { $env:CLAUDE_USER_DIR } elseif ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
$ManagedFile = Join-Path $SysDir 'managed-settings.json'
$UserFile = Join-Path $UserDir 'settings.json'

function Die($m) { Write-Host "error: $m" -ForegroundColor Red; exit 1 }
function Ok($m) { Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!]  $m" -ForegroundColor Yellow }
$script:Failed = $false
function Bad($m) { Write-Host "  [x]  $m" -ForegroundColor Red; $script:Failed = $true }

# ---- arguments ----
$FlagUrl = ''; $FlagDefaults = ''; $FlagModels = ''; $Dry = $false; $Yes = $false; $NoUser = $false; $Dev = $false; $ForceOld = $false; $Force = $false; $Pos = @()
for ($i = 0; $i -lt $Rest.Count; $i++) {
  switch -Regex ($Rest[$i]) {
    '^--gateway-url$' { $i++; $FlagUrl = $Rest[$i] }
    '^--gateway-url=' { $FlagUrl = $Rest[$i].Substring(14) }
    '^--defaults$' { $i++; $FlagDefaults = $Rest[$i] }
    '^--models$' { $i++; $FlagModels = $Rest[$i] }
    '^--dry-run$' { $Dry = $true }
    '^(--yes|-y)$' { $Yes = $true }
    '^--no-user-settings$' { $NoUser = $true }
    '^(--dev|--allow-overrides)$' { $Dev = $true }
    '^--force-old-claude$' { $ForceOld = $true }
    '^--force$' { $Force = $true }
    '^-' { Die "unknown option '$($Rest[$i])'" }
    default { $Pos += $Rest[$i] }
  }
}
if ($Pos.Count -lt 1) { Write-Host (Get-Content $PSCommandPath -TotalCount 9 | Select-Object -Skip 4 | Out-String); exit 1 }
$Cmd = $Pos[0]; $Arg2 = if ($Pos.Count -gt 1) { $Pos[1] } else { '' }

# ---- JSON helpers (PowerShell 5.1 compatible) ----
function ConvertTo-Hash($o) {
  if ($o -is [System.Management.Automation.PSCustomObject]) { $h = [ordered]@{}; foreach ($p in $o.PSObject.Properties) { $h[$p.Name] = ConvertTo-Hash $p.Value }; return $h }
  if ($o -is [System.Array]) { return , @($o | ForEach-Object { ConvertTo-Hash $_ }) }
  return $o
}
function Read-JsonText($text, $label) { try { return ConvertTo-Hash ($text | ConvertFrom-Json) } catch { Die "$label is not valid JSON ($($_.Exception.Message))" } }
function Read-JsonFile($path) {
  if (-not (Test-Path $path)) { return [ordered]@{} }
  $h = Read-JsonText (Get-Content -Raw $path) $path
  if ($h -isnot [System.Collections.IDictionary]) { Die "$path must hold a JSON object" }
  return $h
}
function To-Json($h) { return ($h | ConvertTo-Json -Depth 8) }
function From-B64($s) { return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)) }

# ---- catalog, defaults, gateway ----
$Stamped = [bool]($StampGatewayUrlB64 -or $StampModelsB64 -or $StampDefaultsB64)
$UseSiblings = (-not $Stamped) -or $Dev; $UseEnv = $UseSiblings
function Notice($m) { Write-Host "  [!]  $m" -ForegroundColor Yellow }
if ($Stamped -and -not $Dev) {
  foreach ($f in 'defaults.json', 'models.json') { if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot $f))) { Notice "ignoring $f next to this installer: this is your admin's installer and its built-in settings win (use --dev to test with local files)." } }
  if ($env:CLAUDE_GATEWAY_URL) { Notice 'ignoring the CLAUDE_GATEWAY_URL environment variable: this installer''s gateway is built in (use --dev to override).' }
  if ($env:CLAUDE_GATEWAY_MODELS) { Notice 'ignoring the CLAUDE_GATEWAY_MODELS environment variable: this installer''s catalog is built in (use --dev to override).' }
}
$CatalogSrc = 'built-in table'; $DefaultsSrc = 'built-in defaults'; $CatalogOverride = $false; $DefaultsOverride = $false
$Catalog = [ordered]@{ default = 'sonnet'; models = @(
    [ordered]@{ alias = 'sonnet'; id = 'claude-sonnet-5-5'; label = 'Sonnet 5.5'; tier = 'default' },
    [ordered]@{ alias = 'opus'; id = 'claude-opus-5-5'; label = 'Opus 5.5'; tier = 'upgrade' },
    [ordered]@{ alias = 'haiku'; id = 'claude-haiku-5-5'; label = 'Haiku 5.5'; tier = 'fast' }) }
$Defaults = [ordered]@{ gatewayUrl = ''; model = 'sonnet'; effortLevel = 'medium'; userSettings = [ordered]@{} }
# userSettings an admin may add to the engineer's settings: harmless scalar preferences only. Everything else is refused.
$AllowedUserKeys = @('theme', 'verbose', 'alwaysThinkingEnabled', 'includeCoAuthoredBy', 'cleanupPeriodDays', 'outputStyle', 'editorMode', 'spinnerTipsEnabled', 'prefersReducedMotion', 'model', 'effortLevel')
$DefaultsKeys = @('gatewayUrl', 'model', 'effortLevel', 'userSettings')
$mf = if ($FlagModels) { $FlagModels } elseif ($UseEnv -and $env:CLAUDE_GATEWAY_MODELS) { $env:CLAUDE_GATEWAY_MODELS } elseif ($UseSiblings -and $PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'models.json'))) { Join-Path $PSScriptRoot 'models.json' } else { '' }
if ($mf) { if (-not (Test-Path $mf)) { Die "no such catalog file $mf" }; $Catalog = Read-JsonText (Get-Content -Raw $mf) $mf; $CatalogSrc = $mf; $CatalogOverride = $true }
elseif ($StampModelsB64) { $Catalog = Read-JsonText (From-B64 $StampModelsB64) 'the built-in catalog'; $CatalogSrc = 'the catalog built into this installer' }
$df = if ($FlagDefaults) { $FlagDefaults } elseif ($UseSiblings -and $PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'defaults.json'))) { Join-Path $PSScriptRoot 'defaults.json' } else { '' }
$raw = $null
if ($df) { if (-not (Test-Path $df)) { Die "no such defaults file $df" }; $raw = Read-JsonText (Get-Content -Raw $df) $df; $DefaultsSrc = $df; $DefaultsOverride = $true }
elseif ($StampDefaultsB64) { $raw = Read-JsonText (From-B64 $StampDefaultsB64) 'the built-in defaults'; $DefaultsSrc = 'the defaults built into this installer' }
if ($Stamped -and $CatalogOverride) { Notice "OVERRIDE: model catalog from $CatalogSrc instead of the one built into this installer." }
if ($Stamped -and $DefaultsOverride) { Notice "OVERRIDE: defaults from $DefaultsSrc instead of the ones built into this installer." }
if ($raw) {
  foreach ($k in @($raw.Keys)) { if (-not $k.StartsWith('_')) { if ($DefaultsKeys -notcontains $k) { Die "defaults: unknown key '$k' (allowed: $($DefaultsKeys -join ', '))" }; $Defaults[$k] = $raw[$k] } }
}
if ($Defaults.userSettings -isnot [System.Collections.IDictionary]) { Die 'defaults: userSettings must be an object' }
foreach ($k in @($Defaults.userSettings.Keys)) {
  if ($AllowedUserKeys -notcontains $k) { Die "defaults: userSettings key '$k' is not allowed (it could run commands or redirect Claude Code). Allowed keys: $($AllowedUserKeys -join ', ')" }
  $v = $Defaults.userSettings[$k]
  $okv = switch ($k) {
    { $_ -in 'verbose', 'alwaysThinkingEnabled', 'includeCoAuthoredBy', 'spinnerTipsEnabled', 'prefersReducedMotion' } { $v -is [bool] }
    'cleanupPeriodDays' { (($v -is [int]) -or ($v -is [long])) -and $v -ge 1 -and $v -le 3650 }
    'effortLevel' { $Efforts -contains $v }
    'editorMode' { @('normal', 'vim') -contains $v }
    'theme' { ($v -is [string]) -and ($v -cmatch '^[a-z][a-z0-9-]{0,31}\z') }
    'outputStyle' { ($v -is [string]) -and ($v -cmatch '^[A-Za-z][A-Za-z0-9 _-]{0,31}\z') }
    default { ($v -is [string]) -and ($v -cmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\z') }
  }
  if (-not $okv) { Die "defaults: userSettings.$k has a value that is not allowed (booleans only for on/off keys; cleanupPeriodDays is a whole number 1-3650; text is short letters/digits/hyphen)" }
}
if ($Efforts -notcontains $Defaults.effortLevel) { Die "defaults: effortLevel must be one of $($Efforts -join ', ')" }
foreach ($m in @($Catalog.models)) { foreach ($f in 'alias', 'id') { if (($m -isnot [System.Collections.IDictionary]) -or ($m[$f] -isnot [string]) -or ($m[$f] -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\z')) { Die "the model catalog ($CatalogSrc): every model $f must be plain text of letters, digits, '.', '_' or '-' (1-64 characters)" } } }
$Models = @($Catalog.models | Where-Object { $_.enabled -ne $false })
if ($Models.Count -eq 0) { Die "the model catalog ($CatalogSrc) has no enabled models" }

function Find-Model($x) { if (-not $x) { return $null }; foreach ($m in $Models) { if ($m.id -eq $x -or $m.alias -ieq $x) { return $m } }; return $null }
function Resolve-Model($x) { $m = Find-Model $x; if (-not $m) { Die "unknown model '$x'. Choose one of: $(($Models | ForEach-Object { $_.alias }) -join ', ') (or its full id)." }; return $m }
function Get-DefaultModel() {
  $want = if ($Defaults.model) { $Defaults.model } elseif ($Catalog.default) { $Catalog.default } else { $Models[0].alias }
  $m = Find-Model $want; if (-not $m) { Die "the default model '$want' is not an enabled model in the catalog" }; return $m
}
function Test-GatewayUrl($u) {
  # Strict allow-list on the raw text first: letters, digits, dot, hyphen, colon, slash and square brackets only.
  if ($u -notmatch '^[A-Za-z0-9.:/\[\]-]+\z') { Die "not a valid gateway URL: it contains characters that are not allowed in a host name. Use https://host[:port]." }
  if ((($u -replace '^[A-Za-z]+://', '').Split('/')[0]) -match ':\z') { Die 'not a valid gateway URL: an empty port is not allowed.' }
  $x = $null
  if (-not [Uri]::TryCreate($u, [UriKind]::Absolute, [ref]$x) -or @('http', 'https') -notcontains $x.Scheme) { Die "not a valid gateway URL: $u" }
  $h = $x.DnsSafeHost
  $isV6 = $x.HostNameType -eq [UriHostNameType]::IPv6
  $isV4 = $x.HostNameType -eq [UriHostNameType]::IPv4
  if (-not $isV6 -and -not $isV4) {
    if ($h.Length -gt 253 -or ($h.Split('.') | Where-Object { $_ -notmatch '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$' })) { Die 'not a valid gateway URL: bad host name.' }
  }
  $loop = @('localhost', '127.0.0.1', '[::1]', '::1') -contains $x.Host
  if ($x.Scheme -eq 'http' -and -not $loop) { Die "http is only accepted for localhost; use the gateway's https:// address" }
  if (($x.AbsolutePath -ne '/') -or $x.Query -or $x.Fragment -or $x.UserInfo) { Die 'give the gateway origin only (https://host[:port]), with no path' }
}
$GwUrl = ''; $GwFrom = ''
function Resolve-Gateway() {
  if ($FlagUrl) { $script:GwUrl = $FlagUrl; $script:GwFrom = 'the --gateway-url flag'; if ($Stamped) { Notice 'OVERRIDE: gateway from the --gateway-url flag instead of the one built into this installer.' } }
  elseif ($UseEnv -and $env:CLAUDE_GATEWAY_URL) { $script:GwUrl = $env:CLAUDE_GATEWAY_URL; $script:GwFrom = 'the CLAUDE_GATEWAY_URL environment variable' }
  elseif ($Defaults.gatewayUrl) { $script:GwUrl = $Defaults.gatewayUrl; $script:GwFrom = $DefaultsSrc }
  elseif ($StampGatewayUrlB64) { $script:GwUrl = From-B64 $StampGatewayUrlB64; $script:GwFrom = 'your admin (stamped into this installer)' }
}
function Require-Gateway() {
  Resolve-Gateway
  if (-not $GwUrl) { Die "no gateway address is known for this installer. Ask your admin for the company installer, or run: install --gateway-url https://<gateway>" }
  $script:GwUrl = $GwUrl.TrimEnd('/'); Test-GatewayUrl $GwUrl; $script:GwUrl = $GwUrl.ToLowerInvariant()   # canonical lower-case form (only validated characters can be here)
}

# ---- policy (same keys, same order as the bash script) ----
function Get-Policy($url) {
  $dm = Get-DefaultModel
  $ids = @($dm.id) + @($Models | Where-Object { $_.id -ne $dm.id } | ForEach-Object { $_.id })
  $p = [ordered]@{ forceLoginMethod = 'gateway'; forceLoginGatewayUrl = $url; parentSettingsBehavior = 'merge'
    allowedProviders = @('gateway'); availableModels = $ids; enforceAvailableModels = $true }
  $pins = [ordered]@{}
  foreach ($a in $PinKeys.Keys) { foreach ($m in $Models) { if ($m.alias -eq $a) { $pins[$PinKeys[$a]] = $m.id } } }
  if ($pins.Count -gt 0) { $p['env'] = $pins }
  return $p
}
function Merge-Managed($cur, $url) {
  $p = Get-Policy $url
  foreach ($k in $p.Keys) { if ($k -ne 'env') { $cur[$k] = $p[$k] } }
  $ev = if ($cur.Contains('env') -and $cur['env'] -is [System.Collections.IDictionary]) { $cur['env'] } else { [ordered]@{} }
  foreach ($k in $PinKeys.Values) { $ev.Remove($k) }
  if ($p.Contains('env')) { foreach ($k in $p['env'].Keys) { $ev[$k] = $p['env'][$k] } }
  if ($ev.Count -gt 0) { $cur['env'] = $ev } else { $cur.Remove('env') }
  return $cur
}
function Get-Drift($cur, $url) {
  $p = Get-Policy $url; $out = @()
  foreach ($k in $p.Keys) { if ($k -ne 'env' -and (To-Json $cur[$k]) -ne (To-Json $p[$k])) { $out += "$k differs from the catalog/defaults" } }
  $ce = if ($cur.Contains('env') -and $cur['env'] -is [System.Collections.IDictionary]) { $cur['env'] } else { @{} }
  foreach ($k in $PinKeys.Values) { $want = if ($p.Contains('env')) { $p['env'][$k] } else { $null }; if ($ce[$k] -ne $want) { $out += "env.$k differs from the catalog" } }
  return $out
}

# ---- writing ----
function Confirm-Step($q) { if ($Yes -or $Dry) { return }; $a = Read-Host "$q [Y/n]"; if ($a -and $a -notmatch '^(y|yes)$') { Die 'cancelled; nothing was changed.' } }
function Write-Text($path, $text) {
  $dir = Split-Path $path; if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [IO.File]::WriteAllText($path, $text + "`n", (New-Object Text.UTF8Encoding $false))
}
function Write-Managed($cur, [switch]$Remove) {   # an empty policy is only ever removed by an explicit, validated uninstall (-Remove)
  $text = if ($cur -and $cur.Count -gt 0) { To-Json $cur } else { '' }
  if (-not $text -and -not $Remove) { Die 'internal error: refusing to write an empty system policy; nothing was changed.' }
  if ($Remove -and $text) { Die 'internal error: -Remove with content' }
  if ((Test-Path $ManagedFile) -and $text -and ((Get-Content -Raw $ManagedFile).Trim() -eq $text.Trim())) { Ok "system policy already up to date: $ManagedFile"; return }
  if ($Dry) { Write-Host "  [dry run] would write ${ManagedFile}:"; Write-Host $text; return }
  try {
    if (Test-Path $ManagedFile) {
      Copy-Item $ManagedFile "$ManagedFile.bak.$(Get-Date -Format yyyyMMddHHmmss).$([guid]::NewGuid().ToString('N').Substring(0, 8))"
      Get-ChildItem "$ManagedFile.bak.*" | Sort-Object LastWriteTime -Descending | Select-Object -Skip 5 | Remove-Item -Force
    }
    if ($text) { Write-Text $ManagedFile $text } else { Remove-Item $ManagedFile -Force }
  } catch { Die "cannot write $ManagedFile ($($_.Exception.Message)). Run PowerShell as Administrator." }
  Ok "system policy written: $ManagedFile"
}
function Write-User($cur) {
  $text = To-Json $cur
  if ($Dry) { Write-Host "  [dry run] would write ${UserFile}:"; Write-Host $text; return }
  Write-Text $UserFile $text
}
# $null = Claude Code not installed; the string 'unreadable' = installed but the version could not be parsed (treated as too old, never as OK)
function Get-ClaudeVersion() { if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { return $null }; try { $o = (& claude --version 2>$null) | Select-Object -First 1; if ("$o" -match '^(\d+\.\d+\.\d+)(\s|$|[-+])') { return [version]$Matches[1] } } catch {}; return 'unreadable' }
function Test-Bypass() {
  $names = @('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_FOUNDRY') | Where-Object { [Environment]::GetEnvironmentVariable($_) }
  if ($names) { Warn "set in this shell; the policy blocks them, remove them: $($names -join ' ')" } else { Ok 'no leftover API keys or direct-access environment variables found' }
}

# ---- commands ----
function Set-UserKey($k, $v) { $u = Read-JsonFile $UserFile; $u[$k] = $v; Write-User $u }
function Do-Install() {
  Require-Gateway
  Write-Host 'Claude Code gateway setup'; Write-Host "  gateway   $GwUrl`n            from $GwFrom`n  models    from $CatalogSrc`n  defaults  from $DefaultsSrc"
  $v = Get-ClaudeVersion
  if (-not $v) { Warn "Claude Code isn't installed yet (https://code.claude.com/docs/en/setup). Continuing." } elseif (($v -isnot [string]) -and ($v -ge $MinVersion)) { Ok "Claude Code $v" } elseif ($ForceOld) { Warn "WARNING: Claude Code $v is older than $MinVersion or its version could not be read. The provider lock is INEFFECTIVE on it. Continuing only because of --force-old-claude. Run: claude update" } else { Die "Claude Code $v is older than $MinVersion (or its version could not be read), so the provider lock would be silently ineffective on it. Nothing was changed. Run: claude update, or install anyway with --force-old-claude (--yes does not override this)" }
  $newPolicy = Merge-Managed (Read-JsonFile $ManagedFile) $GwUrl      # parse BOTH files before writing anything
  if (-not $NoUser) { $u = Read-JsonFile $UserFile }
  Confirm-Step "Write the system policy to $ManagedFile?"
  Write-Managed $newPolicy
  if ($NoUser) { Write-Host '  - skipped your user settings (--no-user-settings)' }
  else {
    foreach ($k in @($Defaults.userSettings.Keys)) { if (-not $u.Contains($k) -and $k -ne 'model' -and $k -ne 'effortLevel') { $u[$k] = $Defaults.userSettings[$k] } }
    if (-not (Find-Model $u['model'])) { $u['model'] = (Get-DefaultModel).id }
    if ($Efforts -notcontains $u['effortLevel']) { $u['effortLevel'] = $Defaults.effortLevel }
    Write-User $u; Ok "your defaults: model $($u['model']), effort $($u['effortLevel'])"
  }
  Test-Bypass
  Write-Host "`nNext steps:`n  1. Start Claude Code: claude`n  2. Run /login, press Enter on 'Cloud gateway', sign in with your work account`n  3. Check anything: .\claude-gateway-setup.ps1 status"
}
function Do-Update() {
  if (-not (Test-Path $ManagedFile)) { Die "no system policy at $ManagedFile yet; run: install" }
  $cur = Read-JsonFile $ManagedFile
  $url = if ($FlagUrl) { $FlagUrl.TrimEnd('/') } else { [string]$cur['forceLoginGatewayUrl'] }
  if (-not $url) { Require-Gateway; $url = $GwUrl }
  Test-GatewayUrl $url
  foreach ($d in (Get-Drift $cur $url)) { Write-Host "  changed  $d" }
  Confirm-Step "Update $ManagedFile?"
  Write-Managed (Merge-Managed $cur $url)
}
function Do-Status() {
  Write-Host 'Claude Code gateway status'
  $v = Get-ClaudeVersion
  if (-not $v) { Bad 'Claude Code not found on PATH' } elseif (($v -isnot [string]) -and ($v -ge $MinVersion)) { Ok "Claude Code $v" } else { Bad "Claude Code $v is older than $MinVersion or unreadable (run: claude update)" }
  if (Test-Path $ManagedFile) {
    $cur = Read-JsonFile $ManagedFile; $gw = [string]$cur['forceLoginGatewayUrl']
    if ($cur['forceLoginMethod'] -eq 'gateway') { Ok 'sign-in is forced through the gateway' } else { Bad "forceLoginMethod is not 'gateway'" }
    if ((To-Json $cur['allowedProviders']) -eq (To-Json @('gateway'))) { Ok 'other providers are blocked' } else { Bad 'allowedProviders does not lock to the gateway' }
    if ($gw) {
      Ok "gateway URL: $gw"
      foreach ($d in (Get-Drift $cur $gw)) { Bad "policy is out of date: $d (run: update)" }
      try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 "$gw/readyz" | Out-Null; Ok 'gateway reachable and ready' } catch { Bad "cannot reach $gw/readyz (is the VPN/proxy up?)" }
    } else { Bad 'no gateway URL in the policy' }
  } else { Bad "no system policy at $ManagedFile (run: install)" }
  $u = Read-JsonFile $UserFile; $f = Find-Model $u['model']
  if (-not $u['model']) { Warn 'no default model set; the policy default applies' } elseif ($f) { Ok "default model: $($f.label)" } else { Bad "your default model '$($u['model'])' is not in the company catalog; run: reset" }
  Test-Bypass
  if ($script:Failed) { exit 1 }
}

switch ($Cmd) {
  'install' { Do-Install }
  'update' { Do-Update }
  'status' { Do-Status }
  'upgrade' { $m = $Models | Where-Object { $_.tier -eq 'upgrade' } | Select-Object -First 1; if (-not $m) { Die "the catalog has no 'upgrade' model" }; Set-UserKey 'model' $m.id; Ok "default model is now $($m.label)" }
  'downgrade' { $m = Get-DefaultModel; Set-UserKey 'model' $m.id; Ok "default model is back to $($m.label)" }
  'reset' { $u = Read-JsonFile $UserFile; $u['model'] = (Get-DefaultModel).id; $u['effortLevel'] = $Defaults.effortLevel; Write-User $u; Ok 'back to the company defaults' }
  'model' { if (-not $Arg2) { Die 'usage: model <name|id>' }; $m = Resolve-Model $Arg2; Set-UserKey 'model' $m.id; Ok "default model is now $($m.label)" }
  'effort' { if ($Efforts -notcontains $Arg2) { Die 'usage: effort <low|medium|high|xhigh>' }; Set-UserKey 'effortLevel' $Arg2; Ok "thinking effort set to $Arg2" }
  'print-managed' { Require-Gateway; To-Json (Get-Policy $GwUrl) }
  'uninstall' {
    if (-not (Test-Path $ManagedFile)) { Warn "no system policy found at $ManagedFile"; break }
    $cur = Read-JsonFile $ManagedFile          # a file that cannot be parsed stops here: nothing is removed
    Confirm-Step "Remove the gateway policy from $ManagedFile?"
    $want = Get-Policy ([string]$cur['forceLoginGatewayUrl']); $left = @()
    foreach ($k in 'forceLoginMethod', 'forceLoginGatewayUrl', 'parentSettingsBehavior', 'allowedProviders', 'availableModels', 'enforceAvailableModels') {
      if (-not $cur.Contains($k)) { continue }
      if ($Force -or ((To-Json $cur[$k]) -eq (To-Json $want[$k])) -or ($k -eq 'forceLoginGatewayUrl')) { $cur.Remove($k) } else { $left += $k }
    }
    if ($cur.Contains('env') -and $cur['env'] -is [System.Collections.IDictionary]) {
      foreach ($k in $PinKeys.Values) { if ($cur['env'].Contains($k)) { if ($Force -or $cur['env'][$k] -eq $want['env'][$k]) { $cur['env'].Remove($k) } else { $left += "env.$k" } } }
      if ($cur['env'].Count -eq 0) { $cur.Remove('env') }
    }
    if ($cur.Count -eq 0) { Write-Managed $cur -Remove } else { Write-Managed $cur }
    if ($left.Count -gt 0) { Warn "left alone because they no longer match what this installer writes: $($left -join ' '). Remove them too with: uninstall --force" }
  }
  default { Die "unknown command '$Cmd' (install, update, status, upgrade, downgrade, reset, model, effort, print-managed, uninstall)" }
}
