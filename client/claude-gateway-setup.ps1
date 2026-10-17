# UNTESTED. This Windows PowerShell port has NOT been run: no PowerShell was available where it was written.
# The macOS/Linux script (claude-gateway-setup.sh) is the tested reference. Try this on a spare machine first, and
# if anything misbehaves use `print-managed` and deploy the JSON with your device-management tool instead.
#
# Same commands and same policy JSON as the bash script. Run from an elevated (Administrator) PowerShell for install/update/uninstall:
#   .\claude-gateway-setup.ps1 install [--gateway-url URL] [--model NAME|ID] [--dry-run] [--yes] [--no-user-settings] [--defaults F] [--models F] [--force-old-claude]
#   A company-stamped copy ignores defaults.json / models.json next to it and CLAUDE_GATEWAY_URL / CLAUDE_GATEWAY_MODELS unless --dev (or --allow-overrides) is given.
#   .\claude-gateway-setup.ps1 update | status | upgrade | downgrade | reset | print-managed | uninstall | print-lock-recovery
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
$Families = @('sonnet', 'opus', 'haiku')
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
$FlagUrl = ''; $FlagDefaults = ''; $FlagModels = ''; $FlagModel = ''; $Dry = $false; $Yes = $false; $NoUser = $false; $Dev = $false; $ForceOld = $false; $Force = $false; $Pos = @()
for ($i = 0; $i -lt $Rest.Count; $i++) {
  switch -Regex ($Rest[$i]) {
    '^--gateway-url$' { $i++; $FlagUrl = $Rest[$i]; continue }
    '^--gateway-url=' { $FlagUrl = $Rest[$i].Substring(14); continue }
    '^--defaults$' { $i++; $FlagDefaults = $Rest[$i]; continue }
    '^--models$' { $i++; $FlagModels = $Rest[$i]; continue }
    '^--model$' { $i++; $FlagModel = $Rest[$i]; if (-not $FlagModel) { Die '--model needs a model name or id' }; continue }
    '^--model=' { $FlagModel = $Rest[$i].Substring(8); if (-not $FlagModel) { Die '--model needs a model name or id' }; continue }
    '^--dry-run$' { $Dry = $true; continue }
    '^(--yes|-y)$' { $Yes = $true; continue }
    '^--no-user-settings$' { $NoUser = $true; continue }
    '^(--dev|--allow-overrides)$' { $Dev = $true; continue }
    '^--force-old-claude$' { $ForceOld = $true; continue }
    '^--force$' { $Force = $true; continue }
    '^-' { Die "unknown option '$($Rest[$i])'" }
    default { $Pos += $Rest[$i] }
  }
}
if ($Pos.Count -lt 1) { Write-Host (Get-Content $PSCommandPath -TotalCount 9 | Select-Object -Skip 4 | Out-String); exit 1 }
$Cmd = $Pos[0]; $Arg2 = if ($Pos.Count -gt 1) { $Pos[1] } else { '' }
if ($FlagModel -and $Cmd -ne 'install') { Die '--model only applies to install (to change your model later: model <name|id>)' }
if ($FlagModel -and $NoUser) { Die '--model sets your user settings, so it cannot be combined with --no-user-settings' }

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
    [ordered]@{ alias = 'haiku'; id = 'claude-haiku-5-5'; label = 'Haiku 5.5'; tier = 'fast' },
    [ordered]@{ alias = 'sonnet-4-6'; id = 'claude-sonnet-4-6'; family = 'sonnet'; label = 'Sonnet 4.6'; tier = 'previous' },
    [ordered]@{ alias = 'opus-4-6'; id = 'claude-opus-4-6'; family = 'opus'; label = 'Opus 4.6'; tier = 'previous' }) }
$Defaults = [ordered]@{ gatewayUrl = ''; model = ''; effortLevel = 'medium'; userSettings = [ordered]@{}; gatewayInternalNetworks = @() }
# An alias is typed on a command line; an id may also hold '@', ':' and '/' (Vertex forms such as claude-sonnet-4-5@20250929). Values only reach JSON through
# ConvertTo-Json, never a command string, and none of these characters is special there. Same rules as the bash installer.
$AliasRe = '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\z'
$IdRe = '^[A-Za-z0-9][A-Za-z0-9._@:/-]{0,127}\z'
# userSettings an admin may add to the engineer's settings: harmless scalar preferences only. Everything else is refused.
$AllowedUserKeys = @('theme', 'verbose', 'alwaysThinkingEnabled', 'includeCoAuthoredBy', 'cleanupPeriodDays', 'outputStyle', 'editorMode', 'spinnerTipsEnabled', 'prefersReducedMotion', 'model', 'effortLevel')
$DefaultsKeys = @('gatewayUrl', 'model', 'effortLevel', 'userSettings', 'gatewayInternalNetworks')
# ---- addresses (the rule Claude Code applies at /login) and gatewayInternalNetworks ----
# Accepted without any declaration: RFC 1918, link-local, CGNAT 100.64.0.0/10, IPv6 ULA fc00::/7 (and fe80::/10), loopback. Everything else,
# TEST-NET and other documentation ranges included, is "public" and refused unless it sits inside a block declared in gatewayInternalNetworks.
$AcceptedV4 = @('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10')
# gatewayInternalNetworks may not overlap these (Claude Code refuses EVERY new gateway sign-in on the machine if it does).
$GinForbidden = @('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '169.254.0.0/16', '100.64.0.0/10', '198.18.0.0/15', '192.0.0.0/24', '192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24', '0.0.0.0/8', '192.88.99.0/24', '224.0.0.0/4')
function ConvertTo-V4Int($ip) { $b = $ip.GetAddressBytes(); return ([long]$b[0] * 16777216) + ([long]$b[1] * 65536) + ([long]$b[2] * 256) + [long]$b[3] }
function Get-V4Range($cidr) {   # 'a.b.c.d/n' -> @(first, last) as numbers
  $parts = $cidr.Split('/'); $bits = [int]$parts[1]; $n = ConvertTo-V4Int ([System.Net.IPAddress]::Parse($parts[0]))
  $size = [long][math]::Pow(2, 32 - $bits); $first = [long][math]::Floor($n / $size) * $size
  return @($first, ($first + $size - 1))
}
function Test-V4In($ip, $cidr) { $r = Get-V4Range $cidr; $n = ConvertTo-V4Int $ip; return (($n -ge $r[0]) -and ($n -le $r[1])) }
function Get-AddrKind($ip, $declared) {   # loopback | private | declared | public
  $b = $ip.GetAddressBytes()
  if ($b.Length -eq 16) {   # an IPv4-mapped IPv6 address is judged as the IPv4 address inside it
    $mapped = $true; for ($i = 0; $i -lt 10; $i++) { if ($b[$i] -ne 0) { $mapped = $false } }
    if ($mapped -and $b[10] -eq 255 -and $b[11] -eq 255) { $ip = New-Object System.Net.IPAddress (, [byte[]]$b[12..15]); $b = $ip.GetAddressBytes() }
  }
  if ([System.Net.IPAddress]::IsLoopback($ip)) { return 'loopback' }
  if ($b.Length -eq 4) {
    foreach ($c in $AcceptedV4) { if (Test-V4In $ip $c) { return 'private' } }
    foreach ($c in $declared) { if (Test-V4In $ip $c) { return 'declared' } }
    return 'public'
  }
  if ((($b[0] -band 254) -eq 252) -or (($b[0] -eq 254) -and (($b[1] -band 192) -eq 128))) { return 'private' }   # fc00::/7, fe80::/10
  return 'public'
}
function Get-HostKind($url, $declared) {   # every address the name resolves to must be acceptable
  $h = ([Uri]$url).DnsSafeHost; $ips = @(); $x = $null
  if ([System.Net.IPAddress]::TryParse($h, [ref]$x)) { $ips = @($x) }
  else {
    if ($env:CLAUDE_GATEWAY_NO_DNS) { return 'unchecked' }
    try { $ips = @([System.Net.Dns]::GetHostAddresses($h)) } catch { return 'unresolved' }
    if ($ips.Count -eq 0) { return 'unresolved' }
  }
  $kinds = @($ips | ForEach-Object { Get-AddrKind $_ $declared })
  foreach ($k in 'public', 'declared', 'private', 'loopback') { if ($kinds -contains $k) { return $k } }
  return 'unresolved'
}
function Test-Networks($v, $src) {   # the rules Claude Code applies to gatewayInternalNetworks at /login
  if (($v -isnot [System.Array]) -or (@($v | Where-Object { $_ -isnot [string] }).Count -gt 0)) { Die "${src}: gatewayInternalNetworks must be a list of IPv4 blocks such as [`"198.51.101.0/24`"]" }
  if ($v.Count -gt 4) { Die "${src}: gatewayInternalNetworks holds at most four blocks" }
  $ranges = @()
  foreach ($i in $v) {
    if ($i -cnotmatch '^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$') { Die "${src}: gatewayInternalNetworks entry '$i' must be an IPv4 block written as its first address and a prefix, like 198.51.101.0/24" }
    $parts = $i.Split('/'); $ip = $null
    if ((-not [System.Net.IPAddress]::TryParse($parts[0], [ref]$ip)) -or ($ip.ToString() -cne $parts[0])) { Die "${src}: gatewayInternalNetworks entry '$i' is not a valid IPv4 block" }
    $bits = [int]$parts[1]
    if (($bits -lt 8) -or ($bits -gt 32)) { Die "${src}: gatewayInternalNetworks entry '$i' must have a prefix from /8 to /32" }
    $r = Get-V4Range $i
    if ((ConvertTo-V4Int $ip) -ne $r[0]) { Die "${src}: gatewayInternalNetworks entry '$i' is not a block (write its first address, with the host bits zero, like 198.51.101.0/24)" }
    foreach ($f in $GinForbidden) { $fr = Get-V4Range $f; if (($r[0] -le $fr[1]) -and ($fr[0] -le $r[1])) { Die "${src}: gatewayInternalNetworks entry '$i' overlaps $f, which Claude Code either already accepts (private space) or never accepts (documentation, reserved, VPN/NAT64 and multicast space); Claude Code would refuse every gateway sign-in" } }
    foreach ($o in $ranges) { if (($r[0] -le $o.Last) -and ($o.First -le $r[1])) { Die "${src}: gatewayInternalNetworks entries '$($o.Text)' and '$i' overlap; Claude Code refuses overlapping blocks" } }
    $ranges += [pscustomobject]@{ First = $r[0]; Last = $r[1]; Text = $i }
  }
}
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
    default { ($v -is [string]) -and ($v -cmatch $IdRe) }
  }
  if (-not $okv) { Die "defaults: userSettings.$k has a value that is not allowed (booleans only for on/off keys; cleanupPeriodDays is a whole number 1-3650; text is short letters/digits/hyphen)" }
}
if ($Efforts -notcontains $Defaults.effortLevel) { Die "defaults: effortLevel must be one of $($Efforts -join ', ')" }
Test-Networks $Defaults.gatewayInternalNetworks $DefaultsSrc
if (($Catalog -isnot [System.Collections.IDictionary]) -or (-not $Catalog.Contains('models')) -or (@($Catalog.models).Count -eq 0)) { Die "the model catalog ($CatalogSrc) has no models list" }
foreach ($m in @($Catalog.models)) {
  if (($m -isnot [System.Collections.IDictionary]) -or ($m['alias'] -isnot [string]) -or ($m['alias'] -cnotmatch $AliasRe)) { Die "the model catalog ($CatalogSrc): every model alias must be plain text of letters, digits, '.', '_' or '-' (1-64 characters, starting with a letter or digit)" }
  if (($m['id'] -isnot [string]) -or ($m['id'] -cnotmatch $IdRe)) { Die "the model catalog ($CatalogSrc): every model id must be plain text of letters, digits, '.', '_', '-', '@', ':' or '/' (1-128 characters, starting with a letter or digit)" }
}
# family / pin: the same rules as the bash installer. An invalid catalog stops here, before anything is written.
function Get-Family($m) { if ($m.Contains('family')) { return $m['family'] }; $a = ([string]$m['alias']).ToLowerInvariant(); if ($Families -contains $a) { return $a }; return $null }
function Test-Pinned($m) { if ($m['enabled'] -eq $false) { return $false }; if ($m.Contains('pin')) { return ($m['pin'] -eq $true) }; return ((Get-Family $m) -eq ([string]$m['alias']).ToLowerInvariant()) }
$SeenAlias = @{}; $SeenId = New-Object 'System.Collections.Generic.Dictionary[string,object]'   # aliases: case-insensitive (@{}); ids: exact, like the bash installer, the API and Terraform
foreach ($m in @($Catalog.models)) {
  if ($m.Contains('enabled') -and ($m['enabled'] -isnot [bool])) { Die "the model catalog ($CatalogSrc): model enabled must be true or false" }
  if ($m.Contains('family') -and ($Families -cnotcontains $m['family'])) { Die "the model catalog ($CatalogSrc): model $($m['alias']): `"family`" must be one of $($Families -join ', ')" }
  if ($m.Contains('pin') -and ($m['pin'] -isnot [bool])) { Die "the model catalog ($CatalogSrc): model $($m['alias']): `"pin`" must be true or false" }
  $ka = ([string]$m['alias']).ToLowerInvariant()
  if ($SeenAlias.ContainsKey($ka)) { Die "the model catalog ($CatalogSrc): model aliases must be unique (`"$($m['alias'])`" is used twice)" }
  if ($SeenId.ContainsKey($m['id'])) { Die "the model catalog ($CatalogSrc): model ids must be unique (`"$($m['id'])`" is used twice)" }
  $SeenAlias[$ka] = $m; $SeenId[$m['id']] = $m
  if ($m['pin'] -eq $true) {
    if (-not (Get-Family $m)) { Die "the model catalog ($CatalogSrc): model $($m['alias']) is pinned but has no family; add `"family`": `"sonnet`", `"opus`" or `"haiku`"" }
    if ($m['enabled'] -eq $false) { Die "the model catalog ($CatalogSrc): model $($m['alias']) is pinned but disabled; a pinned model must be enabled" }
  }
}
$Models = @($Catalog.models | Where-Object { $_.enabled -ne $false })
if ($Models.Count -eq 0) { Die "the model catalog ($CatalogSrc) has no enabled models" }
$PinnedBy = @{}
foreach ($m in $Models) { if (Test-Pinned $m) { $f = Get-Family $m; if (-not $PinnedBy.ContainsKey($f)) { $PinnedBy[$f] = @() }; $PinnedBy[$f] += $m['alias'] } }
foreach ($f in $PinnedBy.Keys) { if ($PinnedBy[$f].Count -gt 1) { Die "the model catalog ($CatalogSrc): more than one model pins the $f family ($($PinnedBy[$f] -join ', ')). Only one may; set `"pin`": false on the others." } }
if ($Catalog.Contains('default')) {
  $dd = $Catalog['default']
  if (($null -eq $dd) -or (($dd -is [string]) -and ($dd -eq ''))) { Die "the model catalog ($CatalogSrc): `"default`" is empty. Name the alias or id of the default model, or leave the key out (the API and Terraform refuse null and `"`" too)." }
  if (($dd -isnot [string]) -or (($dd -cnotmatch $AliasRe) -and ($dd -cnotmatch $IdRe))) { Die "the model catalog ($CatalogSrc): `"default`" must be a model alias or id" }
  $hit = $SeenAlias[$dd.ToLowerInvariant()]; if ((-not $hit) -and $SeenId.ContainsKey($dd)) { $hit = $SeenId[$dd] }
  if (-not $hit) { Die "the model catalog ($CatalogSrc): `"default`" must be the alias or id of a model in the list (got `"$dd`")" }
  if ($hit['enabled'] -eq $false) { Die "the model catalog ($CatalogSrc): the default model `"$dd`" must be enabled" }
}

function Find-Model($x) { if (($x -isnot [string]) -or (-not $x)) { return $null }; $x = $x.Trim(); foreach ($m in $Models) { if ($m.id -ceq $x -or $m.alias -ieq $x) { return $m } }; return $null }
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
  if (@($Defaults.gatewayInternalNetworks).Count -gt 0) { $p['gatewayInternalNetworks'] = @($Defaults.gatewayInternalNetworks) }   # only when the admin's defaults declare it; an MDM-delivered key is left alone
  $pins = [ordered]@{}
  foreach ($a in $PinKeys.Keys) { foreach ($m in $Models) { if ((Test-Pinned $m) -and ((Get-Family $m) -eq $a)) { $pins[$PinKeys[$a]] = $m.id } } }
  if ($pins.Count -gt 0) { $p['env'] = $pins }
  return $p
}
function Get-CatalogWarnings() {   # legal but probably not intended: a family with entries and no pin
  $out = @()
  foreach ($f in $Families) {
    $mem = @($Models | Where-Object { (Get-Family $_) -eq $f })
    if ($mem.Count -gt 0 -and -not (@($mem | Where-Object { Test-Pinned $_ }).Count -gt 0)) {
      $out += "no model pins the $f family ($(($mem | ForEach-Object { $_['alias'] }) -join ', ')): /model $f would use Claude Code's own $f version, which may not be on the allowed list (HTTP 400). Give one of them `"pin`": true in the model catalog."
    }
  }
  return $out
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
  foreach ($k in $PinKeys.Values) { $want = if ($p.Contains('env')) { $p['env'][$k] } else { $null }; if ($ce[$k] -cne $want) { $out += "env.$k differs from the catalog" } }
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
  if ($FlagModel) { $null = Resolve-Model $FlagModel }       # an unknown --model stops here, before anything is written
  Write-Host 'Claude Code gateway setup'; Write-Host "  gateway   $GwUrl`n            from $GwFrom`n  models    from $CatalogSrc`n  defaults  from $DefaultsSrc"
  $v = Get-ClaudeVersion
  $vt = if ($v -is [string]) { '(version unreadable)' } else { "$v" }
  if (-not $v) { Warn "Claude Code isn't installed yet (https://code.claude.com/docs/en/setup). Continuing." } elseif (($v -isnot [string]) -and ($v -ge $MinVersion)) { Ok "Claude Code $v" } elseif ($ForceOld) { Warn "WARNING: Claude Code $vt is older than $MinVersion or its version could not be read. The provider lock is INEFFECTIVE on it. Continuing only because of --force-old-claude. Run: claude update" } else { Die "Claude Code $vt is older than $MinVersion or its version could not be read, so the provider lock would be silently ineffective on it. Nothing was changed. Run: claude update, or install anyway with --force-old-claude (--yes does not override this)" }
  $declared = @($Defaults.gatewayInternalNetworks)
  if (Test-Path $ManagedFile) { $mc = Read-JsonFile $ManagedFile; if ($mc.Contains('gatewayInternalNetworks') -and $mc['gatewayInternalNetworks'] -is [System.Array]) { $declared += @($mc['gatewayInternalNetworks'] | Where-Object { $_ -is [string] -and $_ -cmatch '^[0-9.]+/[0-9]+$' }) } }
  switch (Get-HostKind $GwUrl $declared) {
    { $_ -in 'loopback', 'private' } { Ok 'gateway address is loopback/private, which Claude Code accepts' }
    'declared' { Ok 'gateway address is inside a gatewayInternalNetworks block (Claude Code also needs this machine to connect from inside the same block)' }
    'public' { Warn "$GwUrl resolves to a public address. Claude Code refuses to sign in to those (it accepts RFC 1918, link-local, CGNAT 100.64.0.0/10, IPv6 ULA and loopback). Use the gateway's private address, or, if your internal network is numbered from public space you own, declare it in the managed setting gatewayInternalNetworks (Claude Code 2.1.268+)." }
    'unresolved' { Warn "could not resolve $GwUrl from here (VPN/proxy down?)" }
  }
  foreach ($w in (Get-CatalogWarnings)) { Warn $w }
  $newPolicy = Merge-Managed (Read-JsonFile $ManagedFile) $GwUrl      # parse BOTH files before writing anything
  if (-not $NoUser) { $u = Read-JsonFile $UserFile }
  Confirm-Step "Write the system policy to $ManagedFile?"
  Write-Managed $newPolicy
  if ($NoUser) { Write-Host '  - skipped your user settings (--no-user-settings)' }
  else {
    foreach ($k in @($Defaults.userSettings.Keys)) { if (-not $u.Contains($k) -and $k -ne 'model' -and $k -ne 'effortLevel') { $u[$k] = $Defaults.userSettings[$k] } }
    if ($FlagModel) { $u['model'] = (Resolve-Model $FlagModel).id } elseif (-not (Find-Model $u['model'])) { $u['model'] = (Get-DefaultModel).id }
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
  foreach ($w in (Get-CatalogWarnings)) { Warn $w }
  $uu = Read-JsonFile $UserFile
  if ($uu['model'] -and -not (Find-Model $uu['model'])) { Warn "your default model '$($uu['model'])' is not in the company catalog, so the policy blocks it. Fix with: reset" }
}
function Do-Status() {
  Write-Host 'Claude Code gateway status'
  $v = Get-ClaudeVersion
  if (-not $v) { Bad 'Claude Code not found on PATH' } elseif ($v -is [string]) { Bad "could not read a version from 'claude --version' (run: claude update)" } elseif ($v -ge $MinVersion) { Ok "Claude Code $v" } else { Bad "Claude Code $v is older than $MinVersion (run: claude update)" }
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
  $dm = Get-DefaultModel
  if (-not $u['model']) { Warn "no default model set; the policy default applies ($($dm.id))" } elseif ($f -and $f.id -ceq $dm.id) { Ok "default model: $($f.label) (company default)" } elseif ($f) { Ok "default model setting: $($f.label) (not the company default, $($dm.label); ``downgrade`` puts it back. A starting model set by the gateway policy outranks this file)" } else { Bad "your default model '$($u['model'])' is not in the company catalog; run: reset" }
  foreach ($w in (Get-CatalogWarnings)) { Warn $w }
  Test-Bypass
  if ($script:Failed) { exit 1 }
}

function Show-PolicyNote($id) { Write-Host "    Note: if your company's gateway policy sets a starting model, Claude Code gives that policy priority over this setting at launch; inside Claude Code use /model, or start with: claude --model $id" }
switch ($Cmd) {
  'install' { Do-Install }
  'update' { Do-Update }
  'status' { Do-Status }
  'upgrade' { $m = $Models | Where-Object { $_.tier -eq 'upgrade' } | Select-Object -First 1; if (-not $m) { Die "the catalog has no 'upgrade' model" }; Set-UserKey 'model' $m.id; Ok "default model is now $($m.label)"; Show-PolicyNote $m.id }
  'downgrade' { $m = Get-DefaultModel; Set-UserKey 'model' $m.id; Ok "default model is back to $($m.label)" }
  'reset' { $u = Read-JsonFile $UserFile; $u['model'] = (Get-DefaultModel).id; $u['effortLevel'] = $Defaults.effortLevel; Write-User $u; Ok 'back to the company defaults' }
  'model' { if (-not $Arg2) { Die 'usage: model <name|id>' }; $m = Resolve-Model $Arg2; Set-UserKey 'model' $m.id; Ok "default model is now $($m.label)"; Show-PolicyNote $m.id }
  'effort' { if ($Efforts -notcontains $Arg2) { Die 'usage: effort <low|medium|high|xhigh>' }; Set-UserKey 'effortLevel' $Arg2; Ok "thinking effort set to $Arg2" }
  'print-managed' { Require-Gateway; To-Json (Get-Policy $GwUrl); foreach ($w in (Get-CatalogWarnings)) { [Console]::Error.WriteLine("  ! $w") } }
  'paths' { Write-Host "managed=$ManagedFile"; Write-Host "user=$UserFile" }
  'print-lock-recovery' {
    Write-Host "Claude Code is locked to the company gateway by the system policy file:`n  $ManagedFile"
    Write-Host "If the gateway is gone for good (or unreachable and you cannot wait), get Claude Code working again, from an elevated (Administrator) PowerShell, with:"
    Write-Host "  .\claude-gateway-setup.ps1 uninstall            remove what this installer added (a backup is kept next to the file)"
    Write-Host "  .\claude-gateway-setup.ps1 uninstall --force    also remove values that were changed since install"
    Write-Host "Then run /logout inside Claude Code. A machine managed by MDM or Group Policy gets its policy back at the next sync; ask your admin to change the policy there."
  }
  'uninstall' {
    if (-not (Test-Path $ManagedFile)) { Warn "no system policy found at $ManagedFile"; break }
    $cur = Read-JsonFile $ManagedFile          # a file that cannot be parsed stops here: nothing is removed
    Confirm-Step "Remove the gateway policy from $ManagedFile?"
    $want = Get-Policy ([string]$cur['forceLoginGatewayUrl']); $left = @()
    foreach ($k in 'forceLoginMethod', 'forceLoginGatewayUrl', 'parentSettingsBehavior', 'allowedProviders', 'availableModels', 'enforceAvailableModels') {
      if (-not $cur.Contains($k)) { continue }
      if ($Force -or ((To-Json $cur[$k]) -eq (To-Json $want[$k])) -or ($k -eq 'forceLoginGatewayUrl')) { $cur.Remove($k) } else { $left += $k }
    }
    if ($cur.Contains('gatewayInternalNetworks') -and (@($Defaults.gatewayInternalNetworks).Count -gt 0)) {   # owned only when the admin's defaults declare it
      if ($Force -or ((To-Json $cur['gatewayInternalNetworks']) -eq (To-Json @($Defaults.gatewayInternalNetworks)))) { $cur.Remove('gatewayInternalNetworks') } else { $left += 'gatewayInternalNetworks' }
    }
    if ($cur.Contains('env') -and $cur['env'] -is [System.Collections.IDictionary]) {
      foreach ($k in $PinKeys.Values) { if ($cur['env'].Contains($k)) { if ($Force -or $cur['env'][$k] -ceq $want['env'][$k]) { $cur['env'].Remove($k) } else { $left += "env.$k" } } }
      if ($cur['env'].Count -eq 0) { $cur.Remove('env') }
    }
    if ($cur.Count -eq 0) { Write-Managed $cur -Remove } else { Write-Managed $cur }
    if ($left.Count -gt 0) {
      if (@($left | Where-Object { $_ -in 'forceLoginMethod', 'forceLoginGatewayUrl', 'allowedProviders' }).Count -gt 0) { Warn "STILL LOCKED: these no longer match what THIS installer would write (an admin changed them, or they came from another version or catalog), so they were left alone: $($left -join ' '). Remove them too with: uninstall --force" }
      else { Warn "left alone because they no longer match what THIS installer would write (an admin changed them, or another version or model catalog wrote them): $($left -join ' '). The sign-in lock itself is gone; these only limit which models can be chosen. To remove them too: uninstall --force" }
    }
  }
  default { Die "unknown command '$Cmd' (install, update, status, upgrade, downgrade, reset, model, effort, print-managed, uninstall, print-lock-recovery)" }
}
