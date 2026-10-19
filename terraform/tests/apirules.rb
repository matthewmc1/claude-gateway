#!/usr/bin/env ruby
# Static checker for rules that ONLY the live Cloud Monitoring API enforces. An offline `terraform plan` accepts any string for an alert
# filter; the first real apply then answers 400. This script reads `terraform show -json` of a plan and encodes the rules we know of,
# so the offline suite fails for the same reasons the API would.
#
#   ruby apirules.rb PLAN.json          prints one line per violation (R<n> ...), then a summary; exit 1 if there is any violation
#
# Rules (the source of each is the Cloud Monitoring API reference, projects.alertPolicies and Aggregation, plus what the first real
# apply of this repo answered; see docs/INSTALL.md "Unverified until applied" for what remains unproven):
#   R1  every alert condition filter names exactly ONE metric (`metric.type = "x"`; one_of(a,b) was refused by the API), and restricts
#       resource.type (the API: "The filter must specify the metric type and the resource type"; a logs-based metric without it was refused)
#   R2  the resource types named by a logs-based metric's condition fit that metric: derived from the resource.type="..." terms of the
#       google_logging_metric filter in the same plan. At least one must overlap (cloud_scheduler_job logs never become a Cloud Run
#       series) and the condition must cover EVERY type the metric can come from (a condition on cloud_run_revision only would never
#       see the Cloud Run job's lines). resource.labels.* must exist on every named resource type.
#   R3  a filter never mixes AND with OR in one group (logfilter.rb lint; one_of(...) is a function call, not an OR)
#   R4  a policy has at least one condition, each with exactly one condition kind; condition display names are unique within a policy
#       (the API docs: "don't use the same display name for multiple conditions in the same policy")
#   R5  aggregations: the aligner is legal for the metric's kind and value type (ALIGN_RATE needs DELTA/CUMULATIVE numeric,
#       ALIGN_SUM/MAX/MEAN need GAUGE or DELTA numeric, ALIGN_PERCENTILE_* needs a DISTRIBUTION), a reducer is legal for the aligner's
#       output and never combined with ALIGN_NONE, alignment_period >= 60s and <= 25h, a threshold duration is a multiple of 60s,
#       an absence duration is >= 120s and a multiple of 60s, filter <= 2048 characters
#   R6  the same filter and aggregation rules for dashboard tiles (a tile filter names one metric; aligners/reducers legal)
#   R7  a metric the checker does not know (not a logging metric of this plan, not in BUILTIN) is a violation: add it to BUILTIN with its
#       documented kind and value type, so the aligners used with it are checked rather than assumed.
require 'json'
require 'open3'

HERE = File.dirname(File.expand_path(__FILE__))
LOGFILTER = File.join(HERE, 'logfilter.rb')

# metric type => [metric kind, value type]. Source: cloud.google.com/monitoring/api/metrics_gcp_p_z (run.googleapis.com) and
# metrics_gcp_c_d (cloudsql.googleapis.com).
BUILTIN = {
  'run.googleapis.com/request_count' => %w[DELTA INT64],
  'run.googleapis.com/request_latencies' => %w[DELTA DISTRIBUTION],
  'run.googleapis.com/container/instance_count' => %w[GAUGE INT64],
  'run.googleapis.com/job/completed_execution_count' => %w[DELTA INT64],
  'cloudsql.googleapis.com/database/cpu/utilization' => %w[GAUGE DOUBLE],
  'cloudsql.googleapis.com/database/disk/utilization' => %w[GAUGE DOUBLE],
  'cloudsql.googleapis.com/database/postgresql/num_backends' => %w[GAUGE INT64]
}.freeze

# monitored resource type => its labels (cloud.google.com/monitoring/api/resources)
RESOURCE_LABELS = {
  'cloud_run_revision' => %w[project_id service_name revision_name location configuration_name],
  'cloud_run_job' => %w[project_id job_name location],
  'cloud_scheduler_job' => %w[project_id job_id location],
  'cloudsql_database' => %w[project_id database_id region]
}.freeze

NUMERIC = %w[INT64 DOUBLE].freeze
# aligner => [allowed kinds, allowed value types, output value type or nil for "same as input"] (Aggregation.Aligner)
ALIGNERS = {
  'ALIGN_NONE' => [%w[GAUGE DELTA CUMULATIVE], %w[INT64 DOUBLE BOOL DISTRIBUTION STRING], nil],
  'ALIGN_DELTA' => [%w[DELTA CUMULATIVE], %w[INT64 DOUBLE DISTRIBUTION], nil],
  'ALIGN_RATE' => [%w[DELTA CUMULATIVE], NUMERIC, 'DOUBLE'],
  'ALIGN_INTERPOLATE' => [%w[GAUGE], NUMERIC, nil],
  'ALIGN_NEXT_OLDER' => [%w[GAUGE], %w[INT64 DOUBLE BOOL DISTRIBUTION STRING], nil],
  'ALIGN_MIN' => [%w[GAUGE DELTA], NUMERIC, nil],
  'ALIGN_MAX' => [%w[GAUGE DELTA], NUMERIC, nil],
  'ALIGN_MEAN' => [%w[GAUGE DELTA], NUMERIC, 'DOUBLE'],
  'ALIGN_COUNT' => [%w[GAUGE DELTA], NUMERIC + ['BOOL'], 'INT64'],
  'ALIGN_SUM' => [%w[GAUGE DELTA], NUMERIC + ['DISTRIBUTION'], nil],
  'ALIGN_STDDEV' => [%w[GAUGE DELTA], NUMERIC, 'DOUBLE'],
  'ALIGN_PERCENT_CHANGE' => [%w[GAUGE DELTA], NUMERIC, 'DOUBLE']
}.tap do |h|
  %w[99 95 50 05].each { |p| h["ALIGN_PERCENTILE_#{p}"] = [%w[GAUGE DELTA], %w[DISTRIBUTION], 'DOUBLE'] }
end.freeze
# reducer => allowed value types of the aligner's output (Aggregation.Reducer; valid for DELTA and GAUGE)
REDUCERS = {
  'REDUCE_NONE' => nil,
  'REDUCE_MEAN' => NUMERIC + ['DISTRIBUTION'],
  'REDUCE_MIN' => NUMERIC,
  'REDUCE_MAX' => NUMERIC,
  'REDUCE_SUM' => NUMERIC + ['DISTRIBUTION'],
  'REDUCE_STDDEV' => NUMERIC + ['DISTRIBUTION'],
  'REDUCE_COUNT' => NUMERIC + %w[BOOL DISTRIBUTION STRING],
  'REDUCE_COUNT_TRUE' => ['BOOL'], 'REDUCE_COUNT_FALSE' => ['BOOL'], 'REDUCE_FRACTION_TRUE' => ['BOOL']
}.tap do |h|
  %w[99 95 50 05].each { |p| h["REDUCE_PERCENTILE_#{p}"] = NUMERIC + ['DISTRIBUTION'] }
end.freeze

$violations = []
$checked = Hash.new(0)
def viol(rule, where, msg)
  $violations << "#{rule} #{where}: #{msg}"
end

def seconds(s)
  s.to_s =~ /\A(\d+)s\z/ ? Regexp.last_match(1).to_i : nil
end

@lint_cache = {}
# R3 through logfilter.rb. one_of(...) / starts_with(...) become a quoted word first: they are function calls in the Monitoring filter
# language, which the Logging lexer does not know.
def lint_filter(filter)
  neutral = filter.gsub(/\b(one_of|starts_with|ends_with|has_substring|monitoring\.regex\.full_match)\(([^)]*)\)/) { "\"#{Regexp.last_match(2).gsub(/["\s]/, '')}\"" }
  @lint_cache[neutral] ||= begin
    _out, err, st = Open3.capture3('ruby', LOGFILTER, 'lint', neutral)
    st.success? ? nil : err.strip
  end
end

# Parse a Monitoring filter into [metric types (all clauses), resource clauses, resource label names].
def clauses(filter)
  metric = filter.scan(/metric\.type\s*(?:=|!=|:|=~)\s*(one_of\([^)]*\)|"[^"]*"|\w+\([^)]*\))/).flatten
  res = filter.scan(/(?<![\w.])resource\.type\s*(?:=|!=|:|=~)\s*(one_of\([^)]*\)|"[^"]*"|\w+\([^)]*\))/).flatten
  labels = filter.scan(/resource\.labels\.(\w+)/).flatten.uniq
  [metric, res, labels]
end

def strings_in(clause)
  clause.scan(/"([^"]*)"/).flatten
end

# Types of metric a plan defines: logging metrics from the plan itself, built-ins from BUILTIN.
def metric_info(plan)
  info = {}
  plan['resource_changes'].each do |rc|
    next unless rc['type'] == 'google_logging_metric'
    a = rc['change']['after'] || {}
    d = (a['metric_descriptor'] || [{}])[0] || {}
    info["logging.googleapis.com/user/#{a['name']}"] = { kind: d['metric_kind'] || 'DELTA', vtype: d['value_type'] || 'INT64',
                                                          rtypes: (a['filter'] || '').scan(/resource\.type\s*=\s*"([^"]+)"/).flatten.uniq, user: true }
  end
  BUILTIN.each { |m, (k, v)| info[m] = { kind: k, vtype: v, rtypes: nil, user: false } }
  info
end

# One filter + aggregation. kind = :threshold | :absent | :dash. Returns nothing; records violations.
def check_series(where, filter, agg, info, kind, duration: nil)
  if filter.nil? || filter.empty?
    viol('R1', where, 'filter is empty or unknown at plan time (cannot be checked)'); return
  end
  $checked[kind] += 1
  viol('R5', where, "filter is #{filter.length} characters (max 2048)") if filter.length > 2048
  metric, res, labels = clauses(filter)
  # R1: one metric, written as a single string
  if metric.length != 1
    viol('R1', where, "the filter must name exactly one metric.type, it has #{metric.length}: #{filter}")
    return
  end
  mnames = strings_in(metric[0])
  if metric[0].start_with?('one_of') || mnames.length != 1
    viol('R1', where, "a condition may name only ONE metric (got #{metric[0]}); use one condition per metric")
    return
  end
  m = mnames[0]
  if filter.scan('logging.googleapis.com/user/').length > 1
    viol('R1', where, 'the filter mentions more than one logs-based metric')
  end
  mi = info[m]
  if mi.nil?
    viol('R7', where, "metric #{m} is neither a logging metric of this plan nor in BUILTIN (apirules.rb): add its documented kind/value type")
    return
  end
  # R1: resource.type restriction (alert conditions only: a dashboard tile needs just one metric)
  rtypes = []
  if kind != :dash
    if res.length != 1
      viol('R1', where, "the filter must restrict resource.type exactly once (has #{res.length}): #{filter}")
    else
      rtypes = strings_in(res[0])
      viol('R1', where, "resource.type clause is not an exact match list: #{res[0]}") if rtypes.empty? || res[0] !~ /\A(one_of\(|")/
    end
  else
    rtypes = res.flat_map { |c| strings_in(c) }
  end
  # R2
  unless rtypes.empty?
    rtypes.each { |t| viol('R2', where, "unknown resource type #{t} (add it to RESOURCE_LABELS with its labels)") unless RESOURCE_LABELS.key?(t) }
    if mi[:user] && !mi[:rtypes].empty?
      viol('R2', where, "logs-based metric #{m.split('/').last} comes from #{mi[:rtypes].join(', ')} (its log filter), the condition names #{rtypes.join(', ')}: no overlap, it would never have data") if (rtypes & mi[:rtypes]).empty?
      missing = mi[:rtypes] - rtypes
      viol('R2', where, "logs-based metric #{m.split('/').last} also comes from #{missing.join(', ')}, which the condition's resource.type leaves out") unless missing.empty? || (rtypes & mi[:rtypes]).empty?
    end
    labels.each do |l|
      rtypes.each do |t|
        viol('R2', where, "resource.labels.#{l} does not exist on #{t} (has #{RESOURCE_LABELS[t].join(', ')})") if RESOURCE_LABELS[t] && !RESOURCE_LABELS[t].include?(l)
      end
    end
  end
  # R3
  err = lint_filter(filter)
  viol('R3', where, "#{err}: #{filter}") if err
  # R5/R6: aggregation and durations
  agg ||= {}
  al = agg['per_series_aligner']; al = nil if al.to_s.empty?
  rd = agg['cross_series_reducer']; rd = nil if rd.to_s.empty?
  per = agg['alignment_period']
  secs = per ? seconds(per) : nil
  rule = kind == :dash ? 'R6' : 'R5'
  if al && al != 'ALIGN_NONE'
    if secs.nil? then viol(rule, where, 'a per-series aligner needs an alignment_period (like "300s")')
    else
      viol(rule, where, "alignment_period #{per} is below 60s") if secs < 60
      viol(rule, where, "alignment_period #{per} is above 25h (90000s)") if secs > 90_000 && kind != :dash
    end
  end
  out_type = mi[:vtype]
  if al
    spec = ALIGNERS[al]
    if spec.nil? then viol(rule, where, "unknown aligner #{al}")
    else
      kinds, vtypes, out = spec
      viol(rule, where, "#{al} is not valid for a #{mi[:kind]} metric (#{m}); valid for #{kinds.join('/')}") unless kinds.include?(mi[:kind])
      viol(rule, where, "#{al} is not valid for #{mi[:vtype]} values (#{m}); valid for #{vtypes.join('/')}") unless vtypes.include?(mi[:vtype])
      out_type = out || mi[:vtype]
    end
  end
  if rd && rd != 'REDUCE_NONE'
    viol(rule, where, "cross_series_reducer #{rd} needs a per-series aligner other than ALIGN_NONE") if al.nil? || al == 'ALIGN_NONE'
    ok_types = REDUCERS[rd]
    if !REDUCERS.key?(rd) then viol(rule, where, "unknown reducer #{rd}")
    elsif ok_types && !ok_types.include?(out_type)
      viol(rule, where, "#{rd} is not valid for #{out_type} values (output of #{al || 'no aligner'} on #{m})")
    end
  end
  return unless duration
  d = seconds(duration)
  if d.nil? then viol('R5', where, "duration #{duration.inspect} is not N seconds")
  else
    viol('R5', where, "duration #{duration} is not a multiple of 60s") unless (d % 60).zero?
    viol('R5', where, "an absence condition's duration must be at least 120s (got #{duration})") if kind == :absent && d < 120
  end
end


# ---- logs-based metrics (R9) and non-monitoring API rules (I1-I8) -------------------------------------------------------------
LOG_FIELD_PREFIXES = %w[resource.type resource.labels. jsonPayload. textPayload severity logName labels. httpRequest. protoPayload. timestamp insertId trace spanId].freeze

def check_log_metric(rc)
  a = rc['change']['after']
  w = "logging metric #{a['name']}"
  f = a['filter'].to_s
  $checked[:log_metrics] += 1
  viol('R9', w, "name must match [A-Za-z0-9_\\-.+~%/]{1,100}") unless a['name'].to_s =~ %r{\A[A-Za-z0-9_\-.+~%/]{1,100}\z}
  viol('R9', w, "filter is #{f.length} characters (max 20000)") if f.length > 20_000
  viol('R9', w, 'filter is empty') if f.strip.empty?
  d = (a['metric_descriptor'] || [{}])[0] || {}
  viol('R9', w, "a counter metric (no value_extractor) must be INT64, is #{d['value_type']}") if a['value_extractor'].to_s.empty? && d['value_type'] && d['value_type'] != 'INT64'
  # field names: every LEFT side of a comparison must be a Cloud Logging field (a misspelt prefix such as `jsonpayload.` matches nothing, silently)
  bare = f.gsub(/"(?:[^"\\]|\\.)*"/, '""')
  bare.scan(/([A-Za-z_][\w.\-]*)\s*(?:=~|!~|>=|<=|!=|=|>|<|:)/).flatten.each do |fld|
    viol('R9', w, "unknown log field #{fld}") unless LOG_FIELD_PREFIXES.any? { |p| fld == p || fld.start_with?(p) }
  end
  rts = f.scan(/resource\.type\s*=\s*"([^"]+)"/).flatten.uniq
  viol('R9', w, 'filter has no resource.type term (a logs-based metric alert needs one to name)') if rts.empty?
  f.scan(/resource\.labels\.(\w+)/).flatten.uniq.each do |l|
    viol('R9', w, "resource.labels.#{l} exists on none of #{rts.join(', ')}") if rts.all? { |t| RESOURCE_LABELS[t] && !RESOURCE_LABELS[t].include?(l) }
  end
end

def seconds_i(s)
  seconds(s)
end

def check_infra(plan)
  rcs = plan['resource_changes'].select { |r| r['change']['after'] }
  by = Hash.new { |h, k| h[k] = [] }
  rcs.each { |r| by[r['type']] << r }
  first = ->(v) { v.is_a?(Array) ? v.first : v }

  # I1 Cloud Scheduler HTTP targets (Cloud Scheduler API ref: oauthToken only for *.googleapis.com, oidcToken otherwise; attemptDeadline
  # 15s..30m; Cloud Run "Execute jobs on a schedule": POST https://run.googleapis.com/v2/projects/P/locations/R/jobs/J:run with an OAuth token)
  jobs = by['google_cloud_run_v2_job'].map { |r| r['change']['after'] }
  by['google_cloud_scheduler_job'].each do |r|
    a = r['change']['after']; w = "scheduler job #{a['name']}"
    $checked[:scheduler] += 1
    ht = first.(a['http_target'])
    next viol('I1', w, 'no http_target') unless ht
    uri = ht['uri'].to_s
    oauth = first.(ht['oauth_token']); oidc = first.(ht['oidc_token'])
    viol('I1', w, "uri is #{uri.length} characters (max 2083)") if uri.length > 2083
    if uri.start_with?('https://run.googleapis.com/')
      viol('I1', w, "a Cloud Run job target must look like https://run.googleapis.com/v2/projects/<p>/locations/<r>/jobs/<job>:run, is #{uri}") unless uri =~ %r{\Ahttps://run\.googleapis\.com/v2/projects/[^/]+/locations/[^/]+/jobs/([a-z][a-z0-9-]*):run\z}
      viol('I1', w, '*.googleapis.com targets need an oauth_token and no oidc_token') unless oauth && !oidc
      viol('I1', w, 'method must be POST for :run') unless ht['http_method'] == 'POST'
      jn = uri[%r{/jobs/([^/:]+):run\z}, 1]
      viol('I1', w, "the :run URI names job #{jn}, which this plan does not create") if jn && !jobs.any? { |j| j['name'] == jn }
      jl = uri[%r{/locations/([^/]+)/}, 1]
      viol('I1', w, "the :run URI region #{jl} differs from the job's region #{a['region']}") if jl && a['region'] && jl != a['region']
      if oauth
        viol('I1', w, 'oauth scope should be https://www.googleapis.com/auth/cloud-platform') unless oauth['scope'].to_s.include?('cloud-platform')
        ok = by['google_cloud_run_v2_job_iam_member'].any? { |m| m['change']['after']['role'] == 'roles/run.invoker' && m['change']['after']['member'] == "serviceAccount:#{oauth['service_account_email']}" && m['change']['after']['name'] == jn }
        viol('I1', w, "the scheduler identity #{oauth['service_account_email']} has no run.invoker on job #{jn}") unless ok
      end
    else
      viol('I1', w, 'a non-Google-API target needs an oidc_token and no oauth_token') unless oidc && !oauth
    end
    dl = seconds_i(a['attempt_deadline'])
    viol('I1', w, "attempt_deadline #{a['attempt_deadline'].inspect} must be 15s..1800s") if a['attempt_deadline'] && (dl.nil? || dl < 15 || dl > 1800)
    if uri.empty? || uri.include?('.run.app')
      # the target is the app's run.app URL: it must still exist
      by['google_cloud_run_v2_service'].each do |s|
        sa = s['change']['after']
        viol('I1', w, "targets the run.app URL of #{sa['name']} but that service has default_uri_disabled = true") if sa['default_uri_disabled'] == true && sa['name'] == 'claude-budget-app'
      end
    end
  end

  # I2 Cloud Run probes (Cloud Run "container health checks": timeout <= period; startup: period 1..600, initial delay 0..600,
  # failure_threshold x period <= 600; liveness: period 1..3600; the probe port is the container port)
  by['google_cloud_run_v2_service'].each do |r|
    a = r['change']['after']
    (first.(a['template']) || {})['containers']&.each do |c|
      $checked[:probes] += 1
      cport = first.(c['ports'])&.dig('container_port')
      %w[startup_probe liveness_probe].each do |k|
        pr = first.(c[k]); next unless pr
        w = "#{a['name']} #{k}"
        t = pr['timeout_seconds'] || 1; per = pr['period_seconds'] || 10; ini = pr['initial_delay_seconds'] || 0; ft = pr['failure_threshold'] || 3
        viol('I2', w, "timeout_seconds #{t} exceeds period_seconds #{per}") if t > per
        maxper = k == 'startup_probe' ? 600 : 3600
        viol('I2', w, "period_seconds #{per} outside 1..#{maxper}") if per < 1 || per > maxper
        viol('I2', w, "initial_delay_seconds #{ini} outside 0..600") if ini < 0 || ini > 600
        viol('I2', w, "failure_threshold x period_seconds = #{ft * per}s exceeds the 600s startup limit") if k == 'startup_probe' && ft * per > 600
        hp = first.(pr['http_get'])
        viol('I2', w, "probe port #{hp['port']} is not the container port #{cport}") if hp && hp['port'] && cport && hp['port'] != cport
      end
    end
  end

  # I3 serverless NEG + load balancer (Load balancing "Serverless NEG overview": no health checks; same region as the Cloud Run service;
  # an internal Application Load Balancer needs a REGIONAL_MANAGED_PROXY subnet, ACTIVE, /26 or larger, in the forwarding rule's region)
  negs = by['google_compute_region_network_endpoint_group']
  svc_loc = by['google_cloud_run_v2_service'].to_h { |s| [s['change']['after']['name'], s['change']['after']['location']] }
  negs.each do |r|
    a = r['change']['after']; $checked[:neg] += 1
    viol('I3', "NEG #{a['name']}", 'must have network_endpoint_type SERVERLESS') unless a['network_endpoint_type'] == 'SERVERLESS'
    sn = first.(a['cloud_run'])&.dig('service')
    viol('I3', "NEG #{a['name']}", "region #{a['region']} differs from Cloud Run service #{sn} (#{svc_loc[sn]})") if sn && svc_loc[sn] && svc_loc[sn] != a['region']
  end
  (by['google_compute_region_backend_service'] + by['google_compute_backend_service']).each do |r|
    a = r['change']['after']
    hcs = a['health_checks']
    viol('I3', "backend service #{a['name']}", 'a serverless NEG backend cannot have health_checks') if hcs.is_a?(Array) && !hcs.empty?
    if r['type'] == 'google_compute_region_backend_service'
      viol('I3', "backend service #{a['name']}", 'a regional backend service must use INTERNAL_MANAGED here') unless a['load_balancing_scheme'] == 'INTERNAL_MANAGED'
      neg_regions = negs.map { |n| n['change']['after']['region'] }.uniq
      viol('I3', "backend service #{a['name']}", "region #{a['region']} has no serverless NEG in it (NEGs are in #{neg_regions.inspect})") unless neg_regions.include?(a['region'])
    else
      viol('I3', "backend service #{a['name']}", "a global backend service here must use EXTERNAL_MANAGED, is #{a['load_balancing_scheme']}") unless a['load_balancing_scheme'] == 'EXTERNAL_MANAGED'
      ifa = first.(a['iap'])
      if ifa && ifa['enabled']
        id = ifa['oauth2_client_id'].to_s; sec = ifa['oauth2_client_secret'].to_s
        viol('I3', "backend service #{a['name']}", 'IAP oauth2_client_id and oauth2_client_secret must be given together (or both omitted for the Google-managed client)') if id.empty? != sec.empty?
      end
    end
  end
  subs = by['google_compute_subnetwork'].map { |r| r['change']['after'] }
  by['google_compute_forwarding_rule'].each do |r|
    a = r['change']['after']; $checked[:forwarding] += 1
    w = "forwarding rule #{a['name']}"
    next unless a['load_balancing_scheme'] == 'INTERNAL_MANAGED'
    ps = subs.select { |s| s['purpose'] == 'REGIONAL_MANAGED_PROXY' }
    viol('I3', w, 'an internal Application Load Balancer needs a proxy-only subnet (purpose REGIONAL_MANAGED_PROXY) in this plan or already in the VPC (unverified for the latter)') if ps.empty?
    ps.each do |s|
      viol('I3', w, "proxy-only subnet #{s['name']} must have role ACTIVE") unless s['role'] == 'ACTIVE'
      viol('I3', w, "proxy-only subnet #{s['name']} is in #{s['region']}, the rule in #{a['region']}") unless s['region'] == a['region']
      viol('I3', w, "proxy-only subnet #{s['name']} #{s['ip_cidr_range']} is smaller than /26") if s['ip_cidr_range'].to_s.split('/')[1].to_i > 26
    end
    viol('I3', w, 'needs a regional target HTTPS proxy and port 443/80') unless a['port_range'].to_s =~ /\A(80|443|8080)\z/
  end
  # I4 resources that were removed from the API
  rcs.each do |r|
    viol('I4', r['address'], 'google_iap_brand / google_iap_client use the IAP OAuth Admin API, shut down on 2026-03-19: create the OAuth client in the console and pass its id/secret') if %w[google_iap_brand google_iap_client].include?(r['type'])
  end
  # I7 Cloud SQL (Cloud SQL "Instance settings": Enterprise custom memory 0.9-6.5 GB per vCPU, a multiple of 256 MB and at least 3.75 GB)
  by['google_sql_database_instance'].each do |r|
    a = r['change']['after']; s = first.(a['settings']) || {}; w = "Cloud SQL #{a['name']}"
    $checked[:sql] += 1
    tier = s['tier'].to_s
    if tier =~ /\Adb-custom-(\d+)-(\d+)\z/
      cpu = Regexp.last_match(1).to_i; mem = Regexp.last_match(2).to_i
      viol('I7', w, "#{tier}: memory must be a multiple of 256 MB") unless (mem % 256).zero?
      viol('I7', w, "#{tier}: memory must be at least 3840 MB") if mem < 3840
      viol('I7', w, "#{tier}: memory must be 0.9-6.5 GB per vCPU") if mem < (0.9 * 1024 * cpu).floor || mem > 6.5 * 1024 * cpu
      viol('I7', w, "#{tier}: vCPUs must be 1 or an even number") unless cpu == 1 || cpu.even?
    elsif !%w[db-f1-micro db-g1-small].include?(tier)
      viol('I7', w, "tier #{tier.inspect} is not db-f1-micro, db-g1-small or db-custom-<vcpu>-<mb> (ENTERPRISE edition)") if s['edition'] == 'ENTERPRISE'
    end
    ip = first.(s['ip_configuration']) || {}
    # private_network is usually unknown at plan time (it is the VPC resource's id); only a KNOWN empty value is a violation
    unk = ((r['change']['after_unknown'] || {})['settings'] || [{}]).first
    unk = ((unk || {})['ip_configuration'] || [{}]).first
    pn_unknown = (unk || {})['private_network'] == true
    viol('I7', w, 'private-IP-only instance needs ip_configuration.private_network') if ip['ipv4_enabled'] == false && ip['private_network'].to_s.empty? && !pn_unknown
  end
end

def check_plan(plan)
  info = metric_info(plan)
  plan['resource_changes'].each do |rc|
    a = rc['change']['after']
    next unless a
    if rc['type'] == 'google_monitoring_alert_policy'
      pname = "policy '#{a['display_name']}' (#{rc['address']})"
      conds = a['conditions'] || []
      $checked[:policies] += 1
      viol('R4', pname, 'has no condition') if conds.empty?
      viol('R4', pname, "has #{conds.length} conditions (the API allows 1 to 6)") if conds.length > 6
      viol('R8', pname, "display_name is #{a['display_name'].to_s.length} characters (max 512)") if a['display_name'].to_s.length > 512
      doc = first_doc = (a['documentation'] || [{}]).first || {}
      c = doc['content'].to_s
      viol('R8', pname, "documentation.content is #{c.length} characters / #{c.bytesize} bytes (max 8192 characters and 10240 bytes)") if c.length > 8192 || c.bytesize > 10_240
      viol('R8', pname, 'documentation.mime_type must be text/markdown') if doc['mime_type'] && doc['mime_type'] != 'text/markdown'
      names = conds.map { |c| c['display_name'] }
      dup = names.group_by { |n| n }.select { |_, v| v.length > 1 }.keys
      viol('R4', pname, "condition display names must be unique within a policy, repeated: #{dup.inspect}") unless dup.empty?
      conds.each do |c|
        cw = "#{pname} condition '#{c['display_name']}'"
        th = (c['condition_threshold'] || []).first
        ab = (c['condition_absent'] || []).first
        kinds = %w[condition_threshold condition_absent condition_matched_log condition_monitoring_query_language condition_prometheus_query_language condition_sql].select { |k| c[k].is_a?(Array) && !c[k].empty? }
        viol('R4', cw, "must have exactly one condition kind, has #{kinds.inspect}") unless kinds.length == 1
        check_series(cw, th['filter'], (th['aggregations'] || []).first, info, :threshold, duration: th['duration']) if th
        check_series(cw, ab['filter'], (ab['aggregations'] || []).first, info, :absent, duration: ab['duration']) if ab
      end
    elsif rc['type'] == 'google_logging_metric'
      check_log_metric(rc)
    elsif rc['type'] == 'google_monitoring_dashboard'
      dash = JSON.parse(a['dashboard_json'] || '{}')
      tiles = (dash['mosaicLayout'] || {})['tiles'] || []
      tiles.each do |t|
        w = t['widget'] || {}
        ((w['xyChart'] || {})['dataSets'] || []).each_with_index do |ds, i|
          f = ((ds['timeSeriesQuery'] || {})['timeSeriesFilter'] || {})
          ag = f['aggregation'] || {}
          agg = { 'per_series_aligner' => ag['perSeriesAligner'], 'cross_series_reducer' => ag['crossSeriesReducer'], 'alignment_period' => ag['alignmentPeriod'] }
          check_series("dashboard tile '#{w['title']}' series #{i}", f['filter'], agg, info, :dash)
        end
      end
    end
  end
end

if $PROGRAM_NAME == __FILE__
  abort 'usage: apirules.rb PLAN.json [PLAN.json...]' if ARGV.empty?
  bad = 0
  ARGV.each do |file|
    $violations = []
    $checked = Hash.new(0)
    plan = JSON.parse(File.read(file))
    check_plan(plan)
    check_infra(plan)
    name = File.basename(file, '.json')
    summary = "#{$checked[:policies]} policies, #{$checked[:threshold]} threshold + #{$checked[:absent]} absence conditions, #{$checked[:dash]} dashboard series, #{$checked[:log_metrics]} log metrics, #{$checked[:scheduler]} scheduler jobs, #{$checked[:probes]} containers, #{$checked[:neg]} NEGs, #{$checked[:sql]} SQL"
    if $violations.empty?
      puts "OK #{name}: #{summary}"
    else
      bad += 1
      puts "FAIL #{name}: #{summary}"
      $violations.each { |v| puts "  #{v}" }
    end
  end
  exit(bad.zero? ? 0 : 1)
end
