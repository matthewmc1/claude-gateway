# Engineer setup

One script points Claude Code at the company gateway and sets sensible defaults.

```bash
# macOS / Linux. Asks for sudo once, to write the system policy.
./claude-gateway-setup.sh install --gateway-url https://<gateway>
claude        # then /login -> "Cloud gateway" -> sign in with your work account
```

## What it sets

| Layer | Where | What | Who can change it |
|---|---|---|---|
| System policy | `/Library/Application Support/ClaudeCode/managed-settings.json` (macOS), `/etc/claude-code/managed-settings.json` (Linux) | Sign in through the gateway only, the gateway URL, no direct Anthropic / Vertex / Bedrock / API-key access (`allowedProviders: ["gateway"]`), only the 5.5 models, aliases pinned to 5.5 | admins |
| Your defaults | `~/.claude/settings.json` | Model **Sonnet 5.5**, effort **medium** | you |

Authentication is the gateway's OIDC sign-in (your company IdP). No API keys or cloud credentials are on the laptop.

## Day to day

```bash
./claude-gateway-setup.sh status          # check this machine end to end
./claude-gateway-setup.sh upgrade         # explicit step up: default model -> Opus 5.5 (costs more, uses budget faster)
./claude-gateway-setup.sh model sonnet    # back to the baseline  (also: opus, haiku)
./claude-gateway-setup.sh effort high     # thinking effort: low | medium | high | xhigh
```

Inside a session the same choices are `/model opus` and `/effort high`, for that session only.

## For admins

```bash
./claude-gateway-setup.sh print-managed --gateway-url https://<gateway>   # JSON for Jamf / Intune / Group Policy
```

Windows: deploy that JSON to `C:\Program Files\ClaudeCode\managed-settings.json` or the
`HKLM\SOFTWARE\Policies\ClaudeCode` registry value with your device-management tool.

Needs Claude Code 2.1.285 or later. The script merges into existing files, keeps a backup of a changed policy, and is safe to re-run.
