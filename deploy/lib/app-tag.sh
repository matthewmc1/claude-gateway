# The budget-app image tag rule, shared by deploy/build-push.sh and (re-implemented as a regex) the app_image_tag variable in
# terraform/variables.tf. A tag must identify ONE build, so mutable-looking names are refused. Accepted shapes:
#   timestamp   8 or more digits only                          20261013093000   (what build-push.sh generates)
#   git sha     7-40 lowercase hex digits                      3f2a9c1, 3f2a9c1d5e...
#   semver      MAJOR.MINOR.PATCH-<build suffix with a digit>  1.4.0-build.7, 1.4.0-rc1
# Refused (any case, as a whole word): latest main master dev develop stable head trunk prod production staging canary nightly.
app_tag_ok() {   # app_tag_ok <tag>
  local t="${1:-}"
  [[ ${#t} -ge 7 && ${#t} -le 128 ]] || return 1
  if [[ "$(printf '%s' "$t" | tr '[:upper:]' '[:lower:]')" =~ (^|[^a-z0-9])(latest|main|master|dev|develop|stable|head|trunk|prod|production|staging|canary|nightly)([^a-z0-9]|$) ]]; then return 1; fi
  [[ "$t" =~ ^[0-9]{8,}$ ]] && return 0
  [[ "$t" =~ ^[0-9a-f]{7,40}$ ]] && return 0
  [[ "$t" =~ ^[0-9]+\.[0-9]+\.[0-9]+-[0-9A-Za-z.-]*[0-9][0-9A-Za-z.-]*$ ]] && return 0
  return 1
}
