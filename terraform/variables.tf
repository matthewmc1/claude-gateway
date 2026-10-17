# Only four things are required: project_id, admin_users, allowed_email_domains (or oidc.google_workspace_domain) and
# the OIDC client id. Everything else has a sensible default. Copy terraform.tfvars.example, or run ./setup.sh.

# ---- project --------------------------------------------------------------------------------------------------------
variable "project_id" {
  description = "Google Cloud project that hosts the gateway and budget app."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a Google Cloud project ID: 6-30 characters, lowercase letters, digits and hyphens, starting with a letter (not the project name or number)."
  }
}

variable "region" {
  description = "Region for Cloud Run, Cloud SQL, the image registry, the state bucket and Cloud Scheduler."
  type        = string
  default     = "europe-west2"
}

variable "profile" {
  description = <<-EOT
    REQUIRED, no default: choose deliberately, because the two profiles are very different.
    "trial": the smallest and cheapest database (db-f1-micro, zonal, NO point-in-time recovery), NO database deletion
    protection, a state bucket that terraform destroy can empty and delete, one warm gateway instance, at most two gateway
    instances, relaxed alert thresholds. Fine for a first look, wrong for anything people depend on.
    "production": a larger highly-available database with point-in-time recovery and deletion protection, two warm gateway
    instances (up to six), 400-day log retention (when managed), tighter alerts, state bucket protected.
    Any individual variable below (db_tier, gateway_min_instances, ...) overrides the profile.
  EOT
  type        = string

  validation {
    condition     = contains(["trial", "production"], var.profile)
    error_message = "profile must be \"trial\" or \"production\" (it has no default: trial means no backups-by-PITR, no deletion protection and a deletable state bucket)."
  }
}

variable "create_project" {
  description = <<-EOT
    OPTIONAL. Create the Google Cloud project as part of this configuration (needs billing_account and exactly one of
    org_id / folder_id). Leave false to use an existing project, which is the normal case. A project created here is
    protected from deletion; remove it with `gcloud projects delete` after `terraform state rm google_project.this[0]`.
    Note: while true, API quota is billed to your own gcloud quota project (user_project_override is off).
  EOT
  type        = bool
  default     = false
}

variable "billing_account" {
  description = "Billing account ID (XXXXXX-XXXXXX-XXXXXX), only used when create_project is true."
  type        = string
  default     = null

  validation {
    condition     = var.billing_account == null || can(regex("^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$", var.billing_account))
    error_message = "billing_account looks like 0123AB-4567CD-89EF01 (see: Billing > Account management in the console)."
  }
}

variable "org_id" {
  description = "Organization ID (digits) to create the project under. Use this or folder_id, only with create_project."
  type        = string
  default     = null

  validation {
    condition     = var.org_id == null || can(regex("^[0-9]+$", var.org_id))
    error_message = "org_id must be the numeric organization ID."
  }
}

variable "folder_id" {
  description = "Folder ID (digits) to create the project under. Use this or org_id, only with create_project."
  type        = string
  default     = null

  validation {
    condition     = var.folder_id == null || can(regex("^[0-9]+$", var.folder_id))
    error_message = "folder_id must be the numeric folder ID."
  }
}

# ---- who administers budgets ----------------------------------------------------------------------------------------
variable "admin_users" {
  description = <<-EOT
    People who can sign in to the budget app and change budgets. Each gets a generated password and their own gateway
    admin key, so the gateway's audit trail names the person who made a change. They are also granted permission to
    reach the private Cloud Run services (run.invoker). Read the credentials with:
      terraform output -json admin_credentials
  EOT
  type = list(object({
    email = string
    name  = optional(string)
  }))

  validation {
    condition     = length(var.admin_users) > 0
    error_message = "Define at least one admin user in admin_users."
  }
  validation {
    condition     = alltrue([for a in var.admin_users : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", a.email))])
    error_message = "Every admin needs a valid email address (for example platform-lead@example.com)."
  }
  validation {
    condition     = length(distinct([for a in var.admin_users : lower(a.email)])) == length(var.admin_users)
    error_message = "admin_users contains the same email twice."
  }
}

variable "view_access" {
  description = "\"open\": anyone allowed to reach the budget app can read usage and budgets (changes always need an admin sign-in). \"admin\": reading needs an admin sign-in too."
  type        = string
  default     = "open"

  validation {
    condition     = contains(["open", "admin"], var.view_access)
    error_message = "view_access must be \"open\" or \"admin\"."
  }
}

variable "extra_invokers" {
  description = "Additional people or groups allowed to reach the private services, e.g. [\"group:platform@example.com\"]. These can open the budget app and see usage."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([for m in var.extra_invokers : (
      can(regex("^(user|group|serviceAccount):[A-Za-z0-9._%+-]+@([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,}$", m)) ||
      can(regex("^domain:([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,}$", m))
    )])
    error_message = "extra_invokers entries must look like user:a@example.com, group:eng@example.com, serviceAccount:x@p.iam.gserviceaccount.com (an email address) or domain:example.com (a DNS name). Wildcards (user:*, domain:*), empty values, allUsers, allAuthenticatedUsers and other public or project-wide members are not accepted: they would make the services public."
  }
  validation {
    condition     = alltrue([for m in var.extra_invokers : !can(regex("(?i)allusers|allauthenticatedusers", m))])
    error_message = "extra_invokers must not contain allUsers or allAuthenticatedUsers: that would make the gateway and budget app public."
  }
}

# ---- sign-in (OIDC) -------------------------------------------------------------------------------------------------
variable "oidc" {
  description = <<-EOT
    How engineers sign in to the gateway.
      issuer                   OIDC issuer. Google accounts by default; use your Okta/Entra issuer for a company IdP.
      client_id                OAuth client ID. For Google it looks like 123456789012-abc123.apps.googleusercontent.com.
                               Leave it out to deploy first with a PLACEHOLDER (sign-in will not work until you set it).
      google_workspace_domain  Optional. With Google, restricts the account chooser to this Workspace domain (hd=) and is
                               the default for allowed_email_domains.
    The client SECRET is the separate variable oidc_client_secret. Google cannot create this client through Terraform or
    any API: see `terraform output oidc_setup_steps`.
  EOT
  type = object({
    issuer                  = optional(string, "https://accounts.google.com")
    client_id               = optional(string)
    google_workspace_domain = optional(string)
  })
  default = {}

  validation {
    condition     = can(regex("^https://", var.oidc.issuer))
    error_message = "oidc.issuer must be an https:// URL, for example https://accounts.google.com."
  }
  validation {
    condition = (
      var.oidc.client_id == null || var.oidc.client_id == "" ||
      !can(regex("^https://accounts\\.google\\.com/?$", var.oidc.issuer)) ||
      can(regex("^[0-9]+-[a-z0-9]+\\.apps\\.googleusercontent\\.com$", var.oidc.client_id))
    )
    error_message = "oidc.client_id is not a Google OAuth client ID. It looks like 123456789012-abc123def456.apps.googleusercontent.com. Create a \"Web application\" client at https://console.cloud.google.com/apis/credentials (see `terraform output oidc_setup_steps`), or leave client_id out to deploy with a placeholder."
  }
  validation {
    condition     = var.oidc.google_workspace_domain == null || can(regex("^[a-z0-9.-]+\\.[a-z]{2,}$", var.oidc.google_workspace_domain))
    error_message = "oidc.google_workspace_domain must be a domain such as example.com."
  }
}

variable "oidc_client_secret" {
  description = "OAuth client secret. Prefer the environment variable TF_VAR_oidc_client_secret, or terraform/secrets.auto.tfvars (git-ignored, written by setup.sh). Null deploys a placeholder."
  type        = string
  sensitive   = true
  default     = null
}

variable "allowed_email_domains" {
  description = "Only people with an email in these domains can sign in to the gateway. Defaults to oidc.google_workspace_domain when that is set."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for d in var.allowed_email_domains : can(regex("^[a-z0-9.-]+\\.[a-z]{2,}$", d))])
    error_message = "allowed_email_domains takes bare domains such as example.com (no @, no spaces)."
  }
}

variable "public_url" {
  description = <<-EOT
    The address engineers' Claude Code connects to; the OIDC redirect URI is <public_url>/oauth/callback. Claude Code only
    accepts a private or localhost gateway: use http://localhost:8891 with deploy/proxy.sh, or the https:// hostname of an
    internal load balancer for a team.
    Leave it unset to get the default: http://localhost:8891 (gateway_exposure = "run_app"), or https://<gateway_hostname> with
    gateway_exposure = "internal_lb" (derived; if you set it too it must be exactly that).
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.public_url == null || can(regex("^(http://(localhost|127\\.0\\.0\\.1|\\[::1\\])|https://([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)*[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(:[0-9]{1,5})?$", var.public_url))
    error_message = "public_url must be an origin: http:// only for localhost, 127.0.0.1 or [::1], otherwise https:// with a plain DNS name (letters, digits, hyphens and dots only), an optional port, and no path, query, spaces or shell characters. Examples: http://localhost:8891, https://claude.internal.example.com."
  }
  validation {
    condition     = var.public_url == null || !can(regex(":[0-9]+$", var.public_url)) ? true : (tonumber(regex(":([0-9]+)$", var.public_url)[0]) >= 1 && tonumber(regex(":([0-9]+)$", var.public_url)[0]) <= 65535)
    error_message = "public_url: the port must be between 1 and 65535."
  }
}

# ---- models and upstreams -------------------------------------------------------------------------------------------
# Models are not a variable: edit config/models.json (single source of truth for the gateway policy, the alias pins
# engineers get and the budget app), then terraform apply.

variable "vertex_region" {
  description = "Default Vertex AI location for the upstream. Claude models are served from \"global\"."
  type        = string
  default     = "global"
}

variable "upstreams" {
  description = <<-EOT
    Where the gateway sends model traffic. Defaults to one Vertex upstream at vertex_region in this project. Add entries
    for another region or project to get failover, e.g.
      upstreams = [{ region = "global" }, { region = "us-east5" }, { region = "global", project_id = "other-project" }]
    A missing region or project_id falls back to vertex_region / project_id.
  EOT
  type = list(object({
    provider   = optional(string, "vertex")
    region     = optional(string)
    project_id = optional(string)
  }))
  default = [{ provider = "vertex" }]

  validation {
    condition     = length(var.upstreams) > 0
    error_message = "Define at least one upstream."
  }
  validation {
    condition     = alltrue([for u in var.upstreams : u.provider == "vertex"])
    error_message = "Only provider = \"vertex\" is supported by this module."
  }
}

variable "upstream_project_iam" {
  description = "Grant the gateway service account roles/aiplatform.user on every upstream project other than project_id. Set false if you manage that access yourself."
  type        = bool
  default     = true
}

# ---- sizing and images (null = take the profile's value) ------------------------------------------------------------
variable "db_tier" {
  description = "Cloud SQL machine tier. Profile default: db-f1-micro (about $10 a month) for trial, db-custom-1-3840 for production."
  type        = string
  default     = null
}

variable "db_deletion_protection" {
  description = "Block terraform destroy from deleting the database. Profile default: false for trial, true for production."
  type        = bool
  default     = null
}

variable "gateway_min_instances" {
  description = "Keep this many gateway instances warm (avoids a cold OIDC discovery on first sign-in). Profile default: 1 trial, 2 production."
  type        = number
  default     = null
}

variable "gateway_max_instances" {
  description = <<-EOT
    Upper bound on gateway instances. Profile default: 2 trial, 6 production. Each instance opens up to
    gateway_store_max_connections Postgres connections, so max_instances x that must fit in the database tier's
    max_connections (checked at plan time; see db_max_connections). Cloud Run answers 429 once all instances are busy
    (about 80 concurrent requests each), which the gateway's own logs never show: the "gateway 429" and "at maximum
    instances" alerts watch for it. Roll-outs briefly run two revisions, so leave headroom.
  EOT
  type        = number
  default     = null

  validation {
    condition     = var.gateway_max_instances == null || (try(var.gateway_max_instances >= 1 && var.gateway_max_instances <= 100 && floor(var.gateway_max_instances) == var.gateway_max_instances, false))
    error_message = "gateway_max_instances must be a whole number between 1 and 100."
  }
}

variable "gateway_store_max_connections" {
  description = "Postgres connections each gateway instance may open (rendered as store.max_connections; the gateway's own default is 5)."
  type        = number
  default     = 5

  validation {
    condition     = try(var.gateway_store_max_connections >= 1 && var.gateway_store_max_connections <= 50 && floor(var.gateway_store_max_connections) == var.gateway_store_max_connections, false)
    error_message = "gateway_store_max_connections must be a whole number between 1 and 50."
  }
}

variable "db_max_connections" {
  description = <<-EOT
    The database's max_connections, for the plan-time check max_instances x gateway_store_max_connections + 5 reserved <=
    this. Null = a conservative floor for the tier (db-f1-micro 25, db-g1-small 50, db-custom-1-3840 100; verify with
    SHOW max_connections). For any other tier the check is skipped unless you set this.
  EOT
  type        = number
  default     = null
}

variable "gateway_cpu" {
  description = "CPU limit of each gateway instance (Cloud Run: 1, 2, 4, ...)."
  type        = string
  default     = "1"
}

variable "gateway_memory" {
  description = "Memory limit of each gateway instance (for example 1Gi). Startup CPU boost is on."
  type        = string
  default     = "1Gi"

  validation {
    condition     = can(regex("^[0-9]+(Mi|Gi)$", var.gateway_memory))
    error_message = "gateway_memory looks like 512Mi or 1Gi."
  }
}

variable "gateway_vertex_role" {
  description = <<-EOT
    Role granted to the gateway's service account on the Vertex AI project(s). The default roles/aiplatform.user is broad
    (it also allows creating datasets, jobs, endpoints). Least privilege is a custom role holding only
    aiplatform.endpoints.predict (what rawPredict / streamRawPredict on publisher models checks); see docs/DEPLOY.md,
    "Least-privilege Vertex role", for the role to create and the test to run BEFORE switching: this variable accepts
    roles/... or projects/<id>/roles/<name>.
  EOT
  type        = string
  default     = "roles/aiplatform.user"

  validation {
    condition     = can(regex("^(roles/[A-Za-z0-9_.]+|projects/[a-z][a-z0-9-]{4,28}[a-z0-9]/roles/[A-Za-z0-9_.]+)$", var.gateway_vertex_role))
    error_message = "gateway_vertex_role is roles/<name> or projects/<project>/roles/<name>."
  }
}

variable "scope_app_log_access" {
  description = <<-EOT
    OPT-IN, needs a matching budget-app release. false (default): the budget app's service account holds roles/logging.viewer
    on the whole project (it can read EVERY log entry of the project, not only the gateway's: IAM conditions cannot narrow
    that project-level role). true: no project-level role; instead a log view limited to the gateway's Cloud Run logs is
    created on the _Default bucket, the app account gets roles/logging.viewAccessor on that view only, and the app gets
    the env var USAGE_LOGS_VIEW with the view's resource name. The app must query that view (resourceNames) instead
    of projects/<id>, otherwise usage views stay empty.
  EOT
  type        = bool
  default     = false
}

variable "db_maintenance_window" {
  description = "Cloud SQL maintenance window (UTC): day 1 (Mon) to 7 (Sun), hour 0-23. Updates may restart the database in this window."
  type        = object({ day = number, hour = number })
  default     = { day = 7, hour = 3 }

  validation {
    condition     = var.db_maintenance_window.day >= 1 && var.db_maintenance_window.day <= 7 && var.db_maintenance_window.hour >= 0 && var.db_maintenance_window.hour <= 23
    error_message = "db_maintenance_window.day is 1-7 and hour is 0-23."
  }
}

variable "gateway_image_tag" {
  description = "Tag of the gateway image in Artifact Registry (the pinned Claude Code release, e.g. 2.1.296). Built by deploy/build-push.sh."
  type        = string
  default     = "2.1.296"
}

variable "app_image_tag" {
  description = <<-EOT
    Tag of the budget-app image in Artifact Registry: the timestamp tag deploy/build-push.sh prints. No default, and it must
    identify one build (8+ digit timestamp, 7-40 hex git sha, or semver-with-build-suffix; never latest/main/dev/stable...):
    a mutable tag means `terraform apply` can never tell a new build from the running one. It may stay unset only
    for the registry-first apply (-target=...); a full plan or apply fails until it is set.
  EOT
  type        = string
  default     = null

  validation {
    condition = var.app_image_tag == null ? true : (
      can(regex("^([0-9]{8,}|[0-9a-f]{7,40}|[0-9]+\\.[0-9]+\\.[0-9]+-[0-9A-Za-z.-]*[0-9][0-9A-Za-z.-]*)$", var.app_image_tag)) &&
      !can(regex("(?i)(^|[^a-z0-9])(latest|main|master|dev|develop|stable|head|trunk|prod|production|staging|canary|nightly)([^a-z0-9]|$)", var.app_image_tag))
    )
    error_message = "app_image_tag must identify one build: the timestamp deploy/build-push.sh printed (8 or more digits, for example 20261013093000), a 7-40 character lower-case hex git sha, or semver with a build suffix (1.4.0-build.7). Mutable-looking tags (latest, main, master, dev, stable, ...) are refused, in any case."
  }
}

# ---- app state, logs, scheduler -------------------------------------------------------------------------------------
variable "state_bucket_force_destroy" {
  description = "Let terraform destroy delete the app state bucket even when it holds objects. Profile default: true for trial, false for production."
  type        = bool
  default     = null
}

variable "manage_log_retention" {
  description = <<-EOT
    Extend retention of the project's _Default log bucket to log_retention_days. The bucket is PROJECT-WIDE (every
    service's logs in this project), so this is off by default and only safe in a project dedicated to the gateway.
    The budget app builds its usage views from the gateway's logs, so retention bounds how far back they reach.
  EOT
  type        = bool
  default     = false
}

variable "log_retention_days" {
  description = "Retention for the _Default log bucket when manage_log_retention is true. Profile default: 30 trial, 400 production. Logs older than 30 days are billed (about $0.01 per GiB-month)."
  type        = number
  default     = null

  validation {
    condition     = var.log_retention_days == null || (try(var.log_retention_days >= 1 && var.log_retention_days <= 3650, false))
    error_message = "log_retention_days must be between 1 and 3650."
  }
}

variable "tick_schedule" {
  description = "Cron schedule of the Cloud Scheduler job that makes the budget app apply and revert budget overrides and ingest usage."
  type        = string
  default     = "* * * * *"
}

# ---- monitoring -----------------------------------------------------------------------------------------------------
variable "enable_monitoring" {
  description = "Create log-based metrics, alert policies, email notification channels and a dashboard."
  type        = bool
  default     = true
}

variable "alert_emails" {
  description = "Who receives alert emails. Defaults to the admin_users emails."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for e in var.alert_emails : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", e))])
    error_message = "alert_emails must be valid email addresses."
  }
}

variable "alert_thresholds" {
  description = <<-EOT
    Override individual alert thresholds (anything left out takes the profile's value):
      gateway_5xx          gateway 5xx responses in 5 minutes (Cloud Run request_count, so it also sees what the gateway never logs)
      gateway_429          Cloud Run 429 responses of the gateway in 5 minutes. Counts EVERYTHING answered 429: Cloud Run
                           shedding load at max instances, Vertex quota relayed by the gateway, and spend-cap refusals
      app_5xx              budget app 5xx responses in 5 minutes
      upstream_errors      upstream provider errors in 5 minutes
      spend_cap_blocks     requests refused by a spend cap in 15 minutes
      security_denials     auth/admin denials and failed app logins in 15 minutes
      sql_cpu              Cloud SQL CPU utilisation, 0-1, sustained 10 minutes
      sql_disk             Cloud SQL disk utilisation, 0-1
      sql_connections      Cloud SQL backends; set to about 80% of your tier's max_connections
      scheduler_failures   failed scheduler attempts in 10 minutes
      override_overdue     override.overdue events in 10 minutes: a boost is past its end and its cap was NOT restored (default 1)
      override_errors      override.error events in 15 minutes (default 5)
      override_failed      override.failed events in 30 minutes (default 1)
      override_lost_claim  override.lost-claim events in 15 minutes (default 5)
      override_creator_removed  override.creator-removed events in 1 hour (default 1)
      store_errors         overrides.store.error events in 10 minutes (default 1)
      tick_errors          tick.error + usage.ingest.error events in 15 minutes (default 3)
      tick_missing_minutes minutes without a scheduler tick before the tick-missing alert fires (default 5; only with the default every-minute tick_schedule)
    The override_* / store_errors / tick_errors values mean "N or more", so 1 alerts on the first event.
  EOT
  type = object({
    gateway_5xx              = optional(number)
    gateway_429              = optional(number)
    app_5xx                  = optional(number)
    upstream_errors          = optional(number)
    spend_cap_blocks         = optional(number)
    security_denials         = optional(number)
    sql_cpu                  = optional(number)
    sql_disk                 = optional(number)
    sql_connections          = optional(number)
    scheduler_failures       = optional(number)
    override_overdue         = optional(number)
    override_errors          = optional(number)
    override_failed          = optional(number)
    override_lost_claim      = optional(number)
    override_creator_removed = optional(number)
    store_errors             = optional(number)
    tick_errors              = optional(number)
    tick_missing_minutes     = optional(number)
  })
  default = {}
}

# ---- engineer install -----------------------------------------------------------------------------------------------
variable "client_default_effort" {
  description = "Thinking effort engineers start with (low | medium | high | xhigh); goes into the client_defaults output."
  type        = string
  default     = "medium"

  validation {
    condition     = contains(["low", "medium", "high", "xhigh"], var.client_default_effort)
    error_message = "client_default_effort must be low, medium, high or xhigh."
  }
}

variable "write_client_defaults" {
  description = "Also write the client_defaults output to ../client/defaults.json for the installer."
  type        = bool
  default     = false
}
