# Engineer setup

Your admin gives you one installer file. It already knows the company gateway and the approved models, so setup takes three commands and no arguments.

## Get going (macOS / Linux)

```bash
bash claude-gateway-setup.sh install     # asks for your password once (it writes the system policy)
claude                                   # start Claude Code
/login                                   # inside Claude Code: press Enter on "Cloud gateway", sign in with your work account
```

Then run `bash claude-gateway-setup.sh status` any time to check the machine end to end.
Want to see what it will do first? `bash claude-gateway-setup.sh install --dry-run` prints exactly what would be written and changes nothing.

Needs Claude Code 2.1.285 or later (`claude update`), `python3` (already on macOS and most Linux) and `sudo` (the system policy is root-owned). On an older Claude Code, or one whose `claude --version` cannot be read, `install` stops with an error and changes nothing, because the provider lock would silently not work there. Run `claude update` and try again. Only `--force-old-claude` overrides this (with a loud warning that the lock is ineffective); `--yes` does not. If Claude Code is not installed at all, install continues and the settings apply once it is.

## What you get

| Layer | Where | What | Who can change it |
|---|---|---|---|
| System policy | `/Library/Application Support/ClaudeCode/managed-settings.json` (macOS), `/etc/claude-code/managed-settings.json` (Linux) | Sign in through the company gateway only, the gateway address, no direct Anthropic / Vertex / Bedrock / API-key access, only the approved models, and the model aliases pinned to them | admins |
| Your defaults | `~/.claude/settings.json` | The company default model (the catalog's `default`, Haiku 5.5 as shipped) and effort (medium; one setting for every model), plus any starter settings your admin chose | you |

Authentication is the gateway's single sign-on (your company identity provider). No API keys or cloud credentials live on your laptop.
Install only fills in what you have not set yourself: a model you chose earlier (if it is still approved) and your own settings are kept, and unrelated settings are never removed.

## Day to day

```bash
bash claude-gateway-setup.sh status            # check this machine; also tells you if the policy is out of date
bash claude-gateway-setup.sh upgrade           # explicit step up to the catalog's "upgrade" model (Opus 5.5 unless your admin changed it): costs more, uses budget faster
bash claude-gateway-setup.sh downgrade         # back to the company default model
bash claude-gateway-setup.sh model haiku       # pick a model by name (sonnet, opus, haiku, sonnet-4-6, opus-4-6) or by full id from the approved list
bash claude-gateway-setup.sh effort high       # thinking effort: low | medium | high | xhigh
bash claude-gateway-setup.sh reset             # back to the company default model and effort
bash claude-gateway-setup.sh update            # refresh the system policy after your admin gives you a NEW installer with changed approved models
bash claude-gateway-setup.sh uninstall         # remove what install added
```

Inside a session the same choices are `/model opus` and `/effort high`, for that session only.

**What `model`, `upgrade`, `downgrade` and `reset` change.** They edit your own `~/.claude/settings.json`. If your company's gateway policy sets a starting model (the repo's Terraform does, to the catalog default), Claude Code gives managed settings priority over your own file, so each launch starts on the company model and you move inside a session with `/model` or `claude --model <id>`. Your setting still applies wherever the policy sets no model. `status` shows both.

**Stepping up from the default.** As shipped you start on Haiku 5.5. Sonnet 4.6 is what `sonnet` means, Opus 5.5 is what `opus` means, and Sonnet 5.5 and Opus 4.6 are approved but only available by name. To use one yourself: `bash claude-gateway-setup.sh model sonnet` (or `sonnet-4-6`, `opus-4-6`, ...), or set it up in one step with `bash claude-gateway-setup.sh install --model sonnet-4-6`. It is saved as your own default model in `~/.claude/settings.json` (and `/model claude-sonnet-4-6` does it for one session); `downgrade` or `reset` goes back to the company default. These commands need an installer built **after** your admin added the model: an older installer says "unknown model".
Add `--dry-run` to any command to preview it. `--no-user-settings` makes `install` touch only the system policy; `--yes` skips questions.
`--model` needs a value (`--model ""` is an error, not "unset"). `install` reads and checks both settings files before it writes anything. If `managed-settings.json` or `~/.claude/settings.json` is not valid JSON (a `//` comment, a stray comma) it stops with an explicit message, exits non-zero, and leaves the file exactly as it was. Fix or move the file and run it again.
If `~/.claude/settings.json` is a symlink (dotfiles repos), the link is kept and the real file it points to is updated.

### If the gateway is gone (recovery)

The system policy locks Claude Code to the company gateway. If that gateway is permanently unreachable and you need Claude Code back, run:

```bash
bash claude-gateway-setup.sh print-lock-recovery     # (also: --print-lock-recovery) prints these steps for this machine
sudo bash claude-gateway-setup.sh uninstall          # removes only what the installer added; a backup stays next to the file
sudo bash claude-gateway-setup.sh uninstall --force  # also removes values that were changed since install
```

then `/logout` inside Claude Code. `status` prints the same hint whenever the installed policy points at a gateway it cannot reach. `uninstall` only removes values that still equal what THIS installer would write; anything else (changed by an admin, or written by a different installer version or model catalog, which is the normal state during a recovery) is left alone, and it tells you which keys, whether the sign-in lock is still in place (`STILL LOCKED`) and how to remove them (`--force`).

## Troubleshooting

| You see | What it means and what to do |
|---|---|
| `Not signed in` in Claude Code, or `/status` shows another login | Run `/logout`, then `/login`, press Enter on **Cloud gateway**, and sign in with your work account. If you are off the network, connect the VPN first: `status` says "cannot reach ... /readyz" when the gateway is not reachable. |
| `... resolves to a public address. Claude Code refuses to sign in to those` | Claude Code only signs in to gateways whose address is loopback, RFC 1918 private, link-local, CGNAT (`100.64.0.0/10`) or IPv6 ULA (documentation ranges such as `203.0.113.0/24` count as public). Ask your admin for the gateway's private address and re-run `install --gateway-url https://<private-address>`. Admins whose internal network uses public address space you own: declare it in `gatewayInternalNetworks` (below). |
| `Claude Code X is older than 2.1.285` | Run `claude update`, then run `install`/`status` again. The provider lock needs 2.1.285 or later; `install` refuses to run on an older one unless you pass `--force-old-claude` (`--yes` does not override). |
| `userSettings key '...' is not allowed` | Admin: your `defaults.json` asks the installer to put a setting into every engineer's `~/.claude/settings.json` that is not on the allow-list (see below). |
| `ignoring .../defaults.json` / `OVERRIDE:` notices | Your admin's installer has its settings built in and deliberately ignores a `defaults.json`/`models.json` next to it and the `CLAUDE_GATEWAY_URL`/`CLAUDE_GATEWAY_MODELS` variables. If you were told to test with local files, add `--dev`. |
| `not valid JSON` from install, update or uninstall | One of your settings files is damaged. Nothing was changed. Fix the named file (or move it away) and run the command again. |
| `cannot reach ... /readyz` and you are locked out for good | See "If the gateway is gone (recovery)" above. |
| `ANTHROPIC_API_KEY` (or `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_VERTEX`, ...) warning | A leftover key or direct-access setting. The policy blocks it, but remove it from your shell profile (`~/.zshrc`, `~/.bashrc`) or from `~/.claude/settings.json` so it cannot confuse you. The installer never prints the value and never deletes your settings for you. |
| `no gateway address is known for this installer` | You are running the plain repo script, not your admin's installer. Ask your admin for it, or run `install --gateway-url https://<gateway>`. |
| `status` says `policy is out of date with the model catalog` | The approved models changed. Get your admin's **current** installer (the old file keeps the old catalog and would report "already matches") and run `update`. |
| `your default model '...' is not in the company catalog` | That model was removed. Run `reset`. |
| `no model pins the sonnet family (...)` | Admin: the catalog has entries for that family but none has `"pin": true`, so `/model sonnet` would use Claude Code's own version, which may not be allowed. Pin one entry. |
| `unknown model 'sonnet-4-6'` | The installer is older than the catalog. Ask your admin for the current installer. |
| `needs administrator rights` | `install` writes the system policy, which needs `sudo`. Run it from an account that has it, or ask your admin to push the policy (see below). |
| `TEST GUARD` | Only seen by the test suite. Ignore. |

## For admins

### Build and host the installer

```bash
scripts/package-client.sh --gateway-url https://gateway.internal.example.com
#   [--models config/models.json] [--defaults client/defaults.json] [--out dist/client]
```

This writes one self-contained installer per platform plus a checksum file to `dist/client/`:

```
claude-gateway-setup.sh     the gateway URL, model catalog and defaults are stamped inside; no other files needed
claude-gateway-setup.ps1    same for Windows PowerShell (untested, see below)
SHA256SUMS                  shasum -a 256 -c SHA256SUMS
```

Host that folder on your own HTTPS site (or push the installer with MDM). Engineers download it, check its hash against one you published somewhere else (see "Trust model"), and run the three commands above.
The build validates the URL (lower-cased and stamped in that canonical form; a plain host name, IPv4 or `[IPv6]` address: only letters, digits, dots, hyphens, colons and brackets; https required except loopback; origin only, no path), validates the catalog and defaults, and **refuses** inputs that contain anything that looks like a secret (keys named `apiKey`/`token`/`password`..., or credential-looking values). Never put secrets in these files.
The URL, catalog and defaults are stamped into the installer as base64 and decoded at run time; they are never pasted into shell (or PowerShell) source, so a hostile value cannot execute anything. A URL such as `https://gw.example.com$(touch x)` is rejected by both `package-client.sh` and `install`. Any tool that prints the install command for engineers (for example a terraform output) should keep the URL quoted for the same reason.

### Trust model (read this before you distribute the installer)

- **The installer is code that engineers run, and `sudo` runs part of it.** Its authenticity comes from how you deliver it, not from anything inside it.
- **`SHA256SUMS` proves nothing about origin.** It only detects a damaged download; anyone who can replace the installer on the server can replace `SHA256SUMS` next to it. Do not treat "the checksum matched" as "my admin made this".
- **Recommended:** host the folder behind your own HTTPS (an internal site or artifact store your admins control), **publish the installer's SHA-256 out of band** (intranet page, ticket, chat message from the admin, or onboarding doc, anywhere that is not the same download location), or deploy the installer with MDM (Jamf, Intune, ...) so it never goes through a download link at all.
- **A stamped installer cannot be overridden from the outside.** It uses only the gateway, catalog and defaults built into it and **ignores** a `defaults.json` / `models.json` next to it and the `CLAUDE_GATEWAY_URL` / `CLAUDE_GATEWAY_MODELS` variables, and says so. Pass `--dev` (alias `--allow-overrides`) to use them deliberately (testing); every override in use prints an `OVERRIDE:` notice. An explicit `--gateway-url`, `--defaults` or `--models` on the command line also works and is announced the same way.
- **`userSettings` is allow-listed.** The only keys an admin's defaults can add to an engineer's `~/.claude/settings.json` are plain UI preferences, each validated for its own type (on/off keys take `true`/`false` only; `cleanupPeriodDays` is a whole number of days from 1 to 3650; `editorMode` is `normal` or `vim`; `theme` and `outputStyle` are short plain text; NaN/Infinity are never accepted): `theme`, `verbose`, `alwaysThinkingEnabled`, `includeCoAuthoredBy`, `cleanupPeriodDays`, `outputStyle`, `editorMode`, `spinnerTipsEnabled`, `prefersReducedMotion` (plus `model` and `effortLevel`, which the installer manages itself). `hooks`, `statusLine`, `apiKeyHelper`, `env`, `permissions`, `mcpServers`, `enabledPlugins` and anything else unknown are refused with an error, by `install`, by `--defaults` files and by `package-client.sh`. Put anything stronger in the system policy via MDM.
- **Optional signature (opt-in, needs only `openssl`):** `package-client.sh ... --sign-key company-signing-key.pem` also writes `claude-gateway-setup.sh.sig` (and `.ps1.sig`), detached SHA-256 signatures, and prints the public key's fingerprint. Keep the private key off the web server, and give engineers the **public** key and its fingerprint through a channel other than the download site. They verify with:

  ```bash
  openssl dgst -sha256 -verify company-installer.pub -signature claude-gateway-setup.sh.sig claude-gateway-setup.sh   # prints "Verified OK"
  ```

  Create a key pair once with `openssl genrsa -out company-signing-key.pem 3072 && openssl pkey -in company-signing-key.pem -pubout -out company-installer.pub`. The key must not be passphrase-protected for `package-client.sh` (it never prompts). gpg and minisign are not used because they are not installed everywhere. The installer does not verify itself (a modified copy could simply skip the check), so verification is a step the engineer or your MDM performs before running it.
- What the installer touches on a machine: the system policy file (via `sudo`, content passed on stdin into a root-owned directory, never staged in a world-writable temp file), `~/.claude/settings.json`, and backups next to the policy. Environment variables `CLAUDE_MANAGED_DIR`, `CLAUDE_USER_DIR` and `CLAUDE_BIN` redirect where it writes / which `claude` it asks for the version; anyone who can set the environment of the person running the installer could already run code as them.

### Where the installer's values come from

Gateway URL, first match wins: `--gateway-url`, then `CLAUDE_GATEWAY_URL`, then `gatewayUrl` in `defaults.json` next to the script (or `--defaults <file>`), then the URL stamped in by `package-client.sh`.
The model catalog is `models.json` next to the script (a copy of `config/models.json`), else the catalog stamped into the installer, else a built-in table.
That order is for the plain repo script and for stamped installers run with `--dev`. A **stamped** installer skips the environment variable and the files next to it (see "Trust model").

`client/defaults.json`:

| Key | Meaning |
|---|---|
| `gatewayUrl` | Optional here; usually left empty and stamped by `package-client.sh` |
| `model` | Optional. Default model, an alias or id from the catalog. Leave it out and the catalog's `default` decides (so switching everyone to another model is one edit in `config/models.json`). |
| `gatewayInternalNetworks` | Optional. IPv4 blocks (`["198.51.101.0/24"]`) written into the system policy for gateways on public address space your organisation owns. Claude Code honours the key only from a managed source on the machine (the system policy file, MDM or registry), never from the gateway's own policy or user settings. Validated like Claude Code does (at most 4 blocks, first address plus `/8`..`/32`, no overlap, nothing overlapping private, documentation, reserved or multicast space; a bad list would block every gateway sign-in), and refused by `install`, `package-client.sh` and `--defaults` otherwise. Needs Claude Code 2.1.268+. Keep `access_control.allow_cidrs` on the gateway at the same blocks. |
| `effortLevel` | `low`, `medium`, `high` or `xhigh` |
| `userSettings` | Extra user-level settings, **allow-listed harmless keys only** (see "Trust model"); merged into each engineer's `~/.claude/settings.json` only where they have not set the key. Other keys make the build and `install` fail. |

### What the system policy contains

`forceLoginMethod: gateway`, `forceLoginGatewayUrl`, `parentSettingsBehavior: merge`, `allowedProviders: ["gateway"]`, `gatewayInternalNetworks` (only when `defaults.json` declares it; a key your MDM delivered is left alone and still counts for the address check) and, generated from the catalog,
`availableModels` (default model first, then every other enabled model), `enforceAvailableModels: true` and the `ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL` pins (only for catalog entries that pin their family: see below). Other keys already in the file are preserved, a changed file is backed up next to it (`managed-settings.json.bak.<time>.<random>`, mode 600, newest 5 kept), and re-running is idempotent. The policy directory is created `0755` and the file `0644` whatever the umask, so the engineer's Claude Code can always read it.

### Push the policy with MDM instead

```bash
client/claude-gateway-setup.sh print-managed --gateway-url https://gateway.internal.example.com   # JSON for Jamf / Intune / Group Policy
```

Deploy it to `/Library/Application Support/ClaudeCode/managed-settings.json` (macOS), `/etc/claude-code/managed-settings.json` (Linux), or `C:\Program Files\ClaudeCode\managed-settings.json` / the `HKLM\SOFTWARE\Policies\ClaudeCode` value (Windows). Engineers can then run `install --no-user-settings` or just `/login`.

### Rotating the gateway URL

Re-run `package-client.sh` with the new URL and host the new files (re-publish the new hash, or re-sign). Engineers re-run `install` (it replaces the URL and keeps a backup); `status` on an old machine reports "the installed gateway differs from this installer's". For MDM, redeploy `print-managed` output. Or, on one machine: `update --gateway-url https://new-gateway`.

### Adding or retiring a model

Edit `config/models.json` (add an entry, or set `"enabled": false`), then `cp config/models.json client/models.json` (keep the two identical; the tests check it), **re-run `package-client.sh` and redistribute the new installer**, and `terraform apply` for the gateway policy. A stamped installer carries its own copy of the catalog: an engineer holding the old file cannot use the new model name (`unknown model`), and its `update` is a no-op.
Engineers get the new catalog by running the **new** installer's `update` (or a fresh `install`); `status` shows "out of date" until they do.
Names: an alias is letters, digits, `.`, `_`, `-` (1-64 characters); an id may also contain `@`, `:` and `/` up to 128 characters, so Vertex forms such as `claude-sonnet-4-5@20250929` work. Both are only ever written through a JSON encoder, never into a shell or PowerShell command line; anything else (spaces, quotes, `$`, backticks, control characters) is refused. A `default` of `null` or `""` is refused here, by the API and by Terraform alike. The tier `upgrade` marks the model `upgrade` steps up to; `default` is chosen by `defaults.json` `model` if you set one, else the catalog's `default`.

**Family and pin.** Claude Code's `sonnet`, `opus` and `haiku` aliases are pinned by the policy to one catalog entry each. An entry has an optional `family` (`sonnet`, `opus` or `haiku`; it defaults to the alias when that is one of them) and an optional `pin` (defaults to true only when alias == family). Every enabled entry is allowed; only a pinned entry sets `ANTHROPIC_DEFAULT_<FAMILY>_MODEL`. So `opus-4-6` (family `opus`, not pinned) is allowed and chosen by name, while the Opus pin stays on Opus 5.5 (Sonnet 4.6 is the shipped Sonnet pin and default; Sonnet 5.5 is allowed by name). The installer refuses a catalog with repeated aliases or ids, two pinned entries in one family, a pinned entry that is disabled or has no family, or a `default` that is missing or disabled, and then changes nothing (so a bad catalog never loosens or removes the lock).

**A family with entries but no pin** (for example only `sonnet` with `"pin": false`) is legal but warned about by `install`, `update`, `status` and `print-managed`: `/model sonnet` would use Claude Code's own version for the alias, which may not be on the allowed list (HTTP 400).

**Make Sonnet 4.6 the default for everyone.** In `config/models.json` set `"default": "sonnet-4-6"`, give `sonnet-4-6` the tier `default` and `haiku` the tier `fast` (the pins stay as they are), reword the `description` strings, copy the file to `client/models.json`, `terraform apply`, rebuild with `package-client.sh` and redistribute. The default model must be enabled in Vertex Model Garden. Engineers run the new installer's `update`. Thinking effort is separate and global: `effortLevel` in `defaults.json` (Terraform `client_default_effort`).

**Run 4.6 as the default for everyone, with 4.6 pinned for both families** (an older catalog where Sonnet 5.5 is the default and pin). In `config/models.json` set `"default": "sonnet-4-6"`, give `sonnet-4-6` and `opus-4-6` `"pin": true` and `sonnet` and `opus` `"pin": false`, swap their `tier` values (4.6 takes `default`/`upgrade`, the 5.5 entries become `previous`, so the app's cards and `upgrade` follow) and reword the `description` strings, copy the file to `client/models.json`, `terraform apply`, rebuild with `package-client.sh` and redistribute. The gateway policy then starts everyone on Sonnet 4.6. On engineers' machines: the new installer's `update` refreshes the machine policy (list and pins); `downgrade` moves a personal model setting to the company default (`reset` also resets effort). The 5.5 entries stay available by name. Leave `model` out of `defaults.json`, since a `model` there overrides the catalog default.

### Windows (UNTESTED)

`claude-gateway-setup.ps1` is a small PowerShell port with the same commands, flags, policy JSON and the same hardening (stamped values are base64 inside single quotes, strict URL check, stamped installers ignore side files and environment unless `--dev`, `userSettings` allow-list, older Claude Code refused, random backup names with the newest 5 kept). **It has not been run**: no PowerShell was available when it was written, so the hardening there is reviewed by reading only. The tested path is macOS/Linux. Try it on a spare machine in an elevated PowerShell (`.\claude-gateway-setup.ps1 install --dry-run` first) and prefer MDM with `print-managed` output for fleet rollout.

### Tests

```bash
client/test/run.sh        # plain bash + python3 (+ openssl for the signature tests); temp dirs and a fake gateway on 127.0.0.1:19350; exit code 0 = all passed
```

The suite never touches the real system or user settings: every run is sandboxed with `CLAUDE_MANAGED_DIR`, `CLAUDE_USER_DIR` and a temp `HOME`, and the installer refuses to run outside the sandbox when `CLAUDE_GATEWAY_TEST_ROOT` is set.
