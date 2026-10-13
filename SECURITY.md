# Security policy

## Reporting a vulnerability

Please report privately. Do not open a public issue or pull request for a security problem.

Use GitHub's private reporting: on <https://github.com/matthewmc1/claude-gateway>, go to **Security**, then **Report a vulnerability**
(a private security advisory). Include what you found, how to reproduce it, the version or commit, and the impact you expect.
Do not include real secrets or other people's data in the report.

This is a volunteer-run project. We aim to acknowledge a report within 5 working days, tell you whether we consider it in scope
within 10, and fix confirmed issues as quickly as we can, coordinating a disclosure date with you. We will credit you in the
advisory unless you prefer not to be named. There is no bug bounty.

If you find a vulnerability in Anthropic's `claude` binary or its built-in gateway, or in Google Cloud, report it to them directly, not here.

## Supported versions

Only the latest commit on `main` and the most recent tagged release receive fixes. Older releases do not.

## Scope

In scope: this repository's code and defaults.

- `api/` (budget app backend: sessions, admin login, write endpoints, request validation)
- `app/` (UI, including anything that could leak the session token or admin keys to the browser)
- `terraform/` and `deploy/` (IAM, networking, secrets handling, the local authenticating proxy)
- `client/claude-gateway-setup.sh` (the policy it writes on engineers' machines)
- the GitHub workflows in `.github/`

Out of scope: a deployment you have configured to be less safe than the defaults (for example `APP_ALLOW_NON_LOOPBACK=1` with no access
control in front, or granting `roles/run.invoker` to `allUsers`); denial of service by authenticated admins; findings that need
control of the machine the app already runs on; vulnerabilities in third-party software with no way to mitigate them here;
automated scanner output without a working exploit.

## Threat model

What the system is trying to protect, and what it is not. Read this before you deploy.

**Protected**

- **Gateway admin keys stay server-side.** The gateway's admin read and write keys live in the environment (locally) or Secret Manager (Cloud Run) and are used only by the `api/` server. The browser never sees them. Admins sign in to the budget app with their own account, and the app attributes each budget change to that person in the gateway's audit trail.
- **Writes need an admin session.** Every endpoint that changes a budget or setting requires one. The app's session token travels in the `x-app-token` header, leaving `Authorization` free for Google IAM.
- **Local-only by default.** The server refuses to listen on anything but loopback unless it is running on Cloud Run or you explicitly set `APP_ALLOW_NON_LOOPBACK=1`.
- **Cloud Run is private by IAM.** The Terraform deploys the gateway and the budget app without public access. Only identities you grant `roles/run.invoker` can reach them, and engineers sign in to the gateway through your identity provider with allowed email domains enforced.
- **No secrets in the repository.** `.env`, state files and real `terraform.tfvars` are git-ignored; secrets are read from the environment and never logged.

**Not protected, by design or for now**

- **Read access is open by default.** With `APP_VIEW_ACCESS=open` (the default), anyone who can reach the app can see usage, per-person spend and budgets without signing in. Set `APP_VIEW_ACCESS=admin` if usage data is sensitive in your organisation, and keep the app on a private network or behind IAM either way.
- **Terraform state contains secrets.** Generated database passwords, JWT secrets and gateway keys are in `terraform.tfstate`. The default is local state, which is fine for a trial only. For anything real, use a private GCS bucket backend with tight IAM and versioning, and never commit or share state files.
- **Admins are trusted.** An admin can change anyone's budget, including removing it. The audit trail records who, but it is not tamper-proof against someone with database access.
- **Usage data reveals who is using Claude and how much.** It contains work email addresses and request counts. Treat it as personal data under your own privacy rules. The app does not store prompts or completions; the gateway's own logs are governed by its configuration.
- **A local proxy or dev stack is not a production deployment.** The Docker Compose stack uses a fake identity provider (Dex) and development passwords.
- **Software supply chain.** Dependabot and CI checks reduce but do not remove the risk in `app/` dependencies. `api/` has no third-party dependencies by design.
- **Client policy can be bypassed by a local administrator.** The installer writes managed policy that routes Claude Code through the gateway, but someone with root on their own laptop can undo it. It guides honest use; it is not endpoint security.

## Safe-deployment checklist

- Keep the Cloud Run services private; grant `run.invoker` only to the people and groups who need it.
- Move Terraform state to a private, versioned GCS bucket before inviting anyone else.
- Decide whether `APP_VIEW_ACCESS` should be `admin` for you.
- Use admin passwords of real strength and gateway admin keys of at least 32 characters; rotate them if they appear anywhere they should not.
- Restrict `allowed_email_domains` to your own domain(s).
