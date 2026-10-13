# Contributing

Thanks for helping. This project gives engineering teams Claude Code through one self-hosted gateway, with a small budget app
on top. Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first: it is the contract between the parts and lists the principles
changes are held to (data is visible and changes are gated, local-only by default, no dependencies in `api/`, honest data).

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately, as described in
[SECURITY.md](SECURITY.md), not in public issues.

## Layout

| Directory | What | Needs |
|---|---|---|
| `api/` | Budget app backend. Plain Node, built-ins and `fetch` only | Node 20 or newer (CI runs 23) |
| `app/` | Budget app UI: Expo, React Native Web, TypeScript | Node and npm |
| `terraform/` | GCP provisioning (Cloud Run, Cloud SQL, Secret Manager, admins) | Terraform 1.5 or newer |
| `client/` | Engineer install script, plain bash | bash, python3 |
| `deploy/gcp/`, `scripts/`, `config/` | Image build, local proxy, local dev stack, model list | Docker for the local stack |

## Dev setup

```bash
git clone https://github.com/matthewmc1/claude-gateway && cd claude-gateway

# backend: nothing to install
cd api && node --test test/*.test.mjs

# UI
cd ../app && npm ci && npx tsc --noEmit

# local stack and demo data (see CLAUDE.md for the full list)
scripts/setup.sh && docker compose up -d && scripts/run-gateway.sh && scripts/run-app.sh   # app on http://localhost:8792
APP_DEMO=1 node api/server.mjs                                                              # no Docker: bannered demo data
```

Keep secrets in `.env` (git-ignored). `scripts/setup.sh` creates one with generated values.

## Running the tests

Run the suite for each part you touched. CI runs all of them.

| Part | Command |
|---|---|
| `api/` | `cd api && node --test test/*.test.mjs` |
| `client/` | `bash client/test/run.sh` |
| `terraform/` | `bash terraform/tests/run.sh` (also `terraform fmt -check -recursive terraform`) |
| `app/` types | `cd app && npx tsc --noEmit` |
| shell syntax | `bash -n client/claude-gateway-setup.sh scripts/*.sh deploy/gcp/*.sh` |

**Never run `client/claude-gateway-setup.sh install` against your real machine while testing.** It writes system policy that
forces every Claude Code on the machine through the gateway. The client tests set `CLAUDE_MANAGED_DIR` and `CLAUDE_USER_DIR` to
temporary directories; do the same if you run it by hand. Do not run `terraform apply` to test a change: `terraform/tests/run.sh` works on a scratch copy of the module, so it never touches your real
state or project.

## Conventions

- **No dependencies in `api/`.** Built-ins and `fetch` only. If you think you need a package, open an issue first.
- **Secrets never get committed.** They come from the environment locally and Secret Manager in the cloud. Never log them, never put them in test fixtures, error messages or URLs. `.env`, `*.tfstate` and `terraform.tfvars` are git-ignored; keep it that way. Use obviously fake values (`test-key-not-a-secret`) in tests.
- **Honest data.** Do not fabricate numbers outside demo mode (`APP_DEMO=1`). If something is not measured, say so in the UI.
- **Read is open, writes are gated.** New write endpoints need an admin session and an audit entry attributed to a person.
- **Small, reviewable changes.** One concern per PR. Match the style of the file you are in.
- **Tests with behaviour changes.** New logic gets a test; a bug fix gets a test that fails without the fix.
- **Terraform:** run `terraform fmt`; new variables need a description and a safe default; mark secret outputs `sensitive`.
- **Shell:** `set -euo pipefail`, quote variables, work on macOS bash 3.2 and Linux.
- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(api): ...`, `fix(client): ...`, `docs: ...`, `chore(ci): ...`, `refactor`, `test`. Imperative mood, subject under 72 characters, explain the why in the body.
- **Brand:** do not add other companies' logos or marks. Artwork lives in `assets/brand/`; see its README.

## Adding or changing a model

`config/models.json` is the single list of models people can use. The gateway policy, the aliases pinned for every engineer and the
budget app's model picker all read it.

1. Add an entry:
   ```jsonc
   {
     "alias": "sonnet",              // short name engineers type; unique, lower case
     "id": "claude-sonnet-5-5",      // the exact Vertex AI model ID
     "label": "Sonnet 5.5",          // shown in the UI
     "tier": "default",              // "default", "upgrade" or "fast"
     "description": "One sentence on when to use it.",
     "enabled": true,
     "pricePerMTok": { "input": null, "output": null, "cacheRead": null, "cacheWrite": null }
   }
   ```
2. Set `pricePerMTok` (USD per million tokens, from your own Vertex price list) only if you want cost hints; `null` hides them. Do not copy prices from memory: wrong prices are worse than none.
3. `default` at the top of the file names the alias new engineers start on. `enabled: false` keeps the entry but treats the model as unavailable in the app.
4. Keep `allowed_models` in `terraform/variables.tf` consistent with the IDs, then run `node --test api/test/*.test.mjs` and `bash terraform/tests/run.sh`.
5. Check the client's wording in `client/claude-gateway-setup.sh` (it names the models it allows) and update docs that list models.

Changes take effect for engineers after `terraform apply` rolls the gateway and they re-run the client install.

## Pull requests

1. Fork, branch from `main`, make the change.
2. Run the checks above for what you touched.
3. Open a PR and fill in the template. Link the issue if there is one.

Checklist (also in the PR template):

- [ ] Tests added or updated, and the relevant suites pass locally
- [ ] No secrets, state files, `.env` or real project IDs / email addresses in the diff
- [ ] No new dependencies in `api/`
- [ ] Docs updated (README, `docs/ARCHITECTURE.md` if a contract changed, `CONTRIBUTING.md` if workflow changed)
- [ ] Commit messages follow Conventional Commits
- [ ] If this changes who can read or change data, `SECURITY.md` is still accurate

## Licence

By contributing you agree your contribution is licensed under the [MIT License](LICENSE).
