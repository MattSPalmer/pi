-- Import the legacy io.datasette.llm SQLite database into the native DB.
-- __LEGACY_PATH__ is replaced with a SQL-escaped path by import_llm.
LOAD sqlite;
ATTACH '__LEGACY_PATH__' AS legacy (TYPE SQLITE, READ_ONLY);

BEGIN TRANSACTION;

INSERT INTO sessions (
    session_id, source, source_path, name, model, started_at, ended_at,
    source_mtime, source_size
)
SELECT
    'llm:' || c.id,
    'llm',
    '__LEGACY_PATH__',
    c.name,
    c.model,
    min(try_cast(replace(substr(r.datetime_utc, 1, 19), ' ', 'T') AS TIMESTAMP)),
    max(try_cast(replace(substr(r.datetime_utc, 1, 19), ' ', 'T') AS TIMESTAMP)),
    to_timestamp(__SOURCE_MTIME__),
    __SOURCE_SIZE__
FROM legacy.conversations c
LEFT JOIN legacy.responses r ON r.conversation_id = c.id
GROUP BY c.id, c.name, c.model
ON CONFLICT (session_id) DO UPDATE SET
    source_path = excluded.source_path,
    name = excluded.name,
    model = excluded.model,
    started_at = excluded.started_at,
    ended_at = excluded.ended_at,
    imported_at = now();

-- Keep a raw event for every legacy response. The fallback preserves useful
-- data even when an old row has no response_json value.
INSERT INTO events (
    event_id, session_id, event_type, sequence, timestamp, raw_json
)
SELECT
    'llm:response:' || r.id,
    'llm:' || r.conversation_id,
    'response',
    row_number() OVER (
        PARTITION BY r.conversation_id ORDER BY r.datetime_utc, r.id
    ),
    try_cast(replace(substr(r.datetime_utc, 1, 19), ' ', 'T') AS TIMESTAMP),
    coalesce(
        try_cast(r.response_json AS JSON),
        json_object(
            'id', r.id,
            'prompt', r.prompt,
            'response', r.response,
            'model', r.model,
            'datetime_utc', r.datetime_utc
        )
    )
FROM legacy.responses r
ON CONFLICT (event_id) DO UPDATE SET
    session_id = excluded.session_id,
    sequence = excluded.sequence,
    timestamp = excluded.timestamp,
    raw_json = excluded.raw_json;

INSERT INTO messages (
    message_id, session_id, event_id, role, content, model, timestamp,
    input_tokens, output_tokens, stop_reason
)
SELECT
    'llm:prompt:' || r.id,
    'llm:' || r.conversation_id,
    'llm:response:' || r.id,
    'user',
    r.prompt,
    r.model,
    try_cast(replace(substr(r.datetime_utc, 1, 19), ' ', 'T') AS TIMESTAMP),
    NULL,
    NULL,
    NULL
FROM legacy.responses r
WHERE r.prompt IS NOT NULL
ON CONFLICT (message_id) DO UPDATE SET
    content = excluded.content,
    model = excluded.model,
    timestamp = excluded.timestamp;

INSERT INTO messages (
    message_id, session_id, event_id, role, content, model, timestamp,
    input_tokens, output_tokens
)
SELECT
    'llm:response:' || r.id,
    'llm:' || r.conversation_id,
    'llm:response:' || r.id,
    'assistant',
    r.response,
    coalesce(r.resolved_model, r.model),
    try_cast(replace(substr(r.datetime_utc, 1, 19), ' ', 'T') AS TIMESTAMP),
    r.input_tokens,
    r.output_tokens
FROM legacy.responses r
ON CONFLICT (message_id) DO UPDATE SET
    content = excluded.content,
    model = excluded.model,
    timestamp = excluded.timestamp,
    input_tokens = excluded.input_tokens,
    output_tokens = excluded.output_tokens;

INSERT INTO tool_calls (
    tool_call_id, session_id, event_id, tool_name, arguments, timestamp
)
SELECT
    'llm:tool_call:' || tc.id,
    'llm:' || r.conversation_id,
    'llm:response:' || r.id,
    coalesce(tc.name, t.name),
    try_cast(tc.arguments AS JSON),
    try_cast(replace(substr(r.datetime_utc, 1, 19), ' ', 'T') AS TIMESTAMP)
FROM legacy.tool_calls tc
JOIN legacy.responses r ON r.id = tc.response_id
LEFT JOIN legacy.tools t ON t.id = tc.tool_id
ON CONFLICT (tool_call_id) DO UPDATE SET
    session_id = excluded.session_id,
    event_id = excluded.event_id,
    tool_name = excluded.tool_name,
    arguments = excluded.arguments,
    timestamp = excluded.timestamp;

INSERT INTO tool_results (
    tool_result_id, tool_call_id, session_id, output, error, timestamp
)
SELECT
    'llm:tool_result:' || tr.id,
    CASE WHEN tr.tool_call_id IS NULL THEN NULL
         ELSE 'llm:tool_call:' || tr.tool_call_id END,
    'llm:' || r.conversation_id,
    tr.output,
    tr.exception,
    try_cast(replace(substr(r.datetime_utc, 1, 19), ' ', 'T') AS TIMESTAMP)
FROM legacy.tool_results tr
JOIN legacy.responses r ON r.id = tr.response_id
ON CONFLICT (tool_result_id) DO UPDATE SET
    tool_call_id = excluded.tool_call_id,
    session_id = excluded.session_id,
    output = excluded.output,
    error = excluded.error,
    timestamp = excluded.timestamp;

COMMIT;
DETACH legacy;
