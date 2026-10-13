-- Analytics views over what the collector writes. Idempotent; apply with
-- scripts/apply-views.sh. Raw tables (otel_logs, otel_traces, otel_metrics_*)
-- are owned by the collector's ClickHouse exporter; never edit them.

-- One row per request that reached /v1/messages, from the gateway's own audit
-- log. This is the gateway-side truth: it includes requests the client never
-- reports (rate limited, rejected by policy, upstream failures).
--
-- outcome:
--   ok             status < 400
--   spend_cap      the gateway refused the request because a spend cap was reached (evt spend.blocked; no upstream involved)
--   upstream_error the model provider refused or failed (quota, 403, 404, 5xx...)
--   rejected       the gateway refused it before the provider (policy, bad request)
CREATE OR REPLACE VIEW otel.v_gateway_requests AS
WITH people AS (
    SELECT LogAttributes['sub'] AS sub, anyLast(LogAttributes['email']) AS email
    FROM otel.otel_logs
    WHERE ServiceName = 'claude-gateway' AND LogAttributes['evt'] = 'inference' AND LogAttributes['email'] != ''
    GROUP BY sub
)
SELECT
    ts, request_id, email, sub, model, upstream, status, latency_ms, is_load_test,
    multiIf(
        status < 400,                         'ok',
        status = 429 AND upstream = '',       'spend_cap',
        upstream != '',                       'upstream_error',
                                              'rejected') AS outcome
FROM (
    -- requests that reached /v1/messages and were answered or refused by the provider
    SELECT
        Timestamp                                         AS ts,
        LogAttributes['request_id']                       AS request_id,
        LogAttributes['email']                            AS email,
        LogAttributes['sub']                              AS sub,
        LogAttributes['model']                            AS model,
        LogAttributes['upstream']                         AS upstream,
        toUInt16OrZero(LogAttributes['status'])           AS status,
        toUInt32OrZero(LogAttributes['ms'])               AS latency_ms,
        LogAttributes['load_test'] = 'true'               AS is_load_test
    FROM otel.otel_logs
    WHERE ServiceName = 'claude-gateway' AND LogAttributes['evt'] = 'inference'
    UNION ALL
    -- requests the gateway itself refused because a spend cap was reached: logged as their own event, with no inference event
    SELECT
        b.Timestamp, b.LogAttributes['request_id'], ifNull(p.email, ''), b.LogAttributes['sub'],
        '', '', toUInt16(429), toUInt32(0), b.LogAttributes['load_test'] = 'true'
    FROM otel.otel_logs AS b
    LEFT JOIN people AS p ON p.sub = b.LogAttributes['sub']
    WHERE b.ServiceName = 'claude-gateway' AND b.LogAttributes['evt'] = 'spend.blocked'
)
LIMIT 1 BY request_id;

-- Why an upstream call failed, joined to v_gateway_requests on request_id.
-- Source is the gateway's plain-text operational log: "<status> <json error body>".
CREATE OR REPLACE VIEW otel.v_upstream_errors AS
SELECT
    Timestamp                                         AS ts,
    LogAttributes['request_id']                       AS request_id,
    toUInt16OrZero(LogAttributes['upstream_status'])  AS upstream_status,
    JSONExtractString(substring(LogAttributes['upstream_error'], position(LogAttributes['upstream_error'], '{')), 'error', 'status')  AS cause,
    JSONExtractString(substring(LogAttributes['upstream_error'], position(LogAttributes['upstream_error'], '{')), 'error', 'message') AS message
FROM otel.otel_logs
WHERE ServiceName = 'claude-gateway' AND LogAttributes['evt'] = 'upstream.error'
LIMIT 1 BY request_id;

-- Sign-in and token rejections (bad/expired token, wrong domain...).
CREATE OR REPLACE VIEW otel.v_gateway_auth_denied AS
SELECT
    Timestamp                       AS ts,
    LogAttributes['request_id']     AS request_id,
    LogAttributes['reason']         AS reason,
    LogAttributes['path']           AS path,
    LogAttributes['client_ip']      AS client_ip
FROM otel.otel_logs
WHERE ServiceName = 'claude-gateway' AND LogAttributes['evt'] = 'auth.denied';
