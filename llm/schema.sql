-- Canonical AI session database schema.
-- This file is safe to apply repeatedly; importers must use stable IDs and
-- upsert their source rows.

CREATE TABLE IF NOT EXISTS sessions (
    session_id VARCHAR PRIMARY KEY,
    source VARCHAR NOT NULL,
    source_path VARCHAR,
    cwd VARCHAR,
    started_at TIMESTAMP,
    ended_at TIMESTAMP,
    name VARCHAR,
    model VARCHAR,
    provider VARCHAR,
    system_prompt VARCHAR,
    imported_at TIMESTAMP DEFAULT current_timestamp,
    source_mtime TIMESTAMP,
    source_size BIGINT
);

CREATE TABLE IF NOT EXISTS events (
    event_id VARCHAR PRIMARY KEY,
    session_id VARCHAR NOT NULL,
    parent_event_id VARCHAR,
    event_type VARCHAR NOT NULL,
    sequence BIGINT,
    timestamp TIMESTAMP,
    raw_json JSON NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);

CREATE TABLE IF NOT EXISTS messages (
    message_id VARCHAR PRIMARY KEY,
    session_id VARCHAR NOT NULL,
    event_id VARCHAR,
    parent_event_id VARCHAR,
    role VARCHAR NOT NULL,
    content VARCHAR,
    thinking VARCHAR,
    model VARCHAR,
    provider VARCHAR,
    timestamp TIMESTAMP,
    input_tokens INTEGER,
    output_tokens INTEGER,
    stop_reason VARCHAR,
    duration_ms BIGINT,
    token_details JSON,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);

CREATE TABLE IF NOT EXISTS tool_calls (
    tool_call_id VARCHAR PRIMARY KEY,
    session_id VARCHAR NOT NULL,
    event_id VARCHAR,
    parent_event_id VARCHAR,
    tool_name VARCHAR,
    arguments JSON,
    timestamp TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);

-- Additive columns for databases created before the compatibility fields.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS system_prompt VARCHAR;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS duration_ms BIGINT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS token_details JSON;

CREATE TABLE IF NOT EXISTS tool_results (
    tool_result_id VARCHAR PRIMARY KEY,
    tool_call_id VARCHAR,
    session_id VARCHAR NOT NULL,
    output VARCHAR,
    error VARCHAR,
    timestamp TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);

CREATE TABLE IF NOT EXISTS attachments (
    attachment_id VARCHAR PRIMARY KEY,
    session_id VARCHAR NOT NULL,
    event_id VARCHAR,
    media_type VARCHAR,
    path VARCHAR,
    sha256 VARCHAR,
    size_bytes BIGINT,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);

-- This is bookkeeping, not the source of truth. Event IDs remain the
-- correctness mechanism for idempotent import.
CREATE TABLE IF NOT EXISTS sync_runs (
    run_id UUID DEFAULT uuid() PRIMARY KEY,
    source_kind VARCHAR NOT NULL,
    root_path VARCHAR,
    started_at TIMESTAMP DEFAULT current_timestamp,
    finished_at TIMESTAMP,
    files_seen BIGINT DEFAULT 0,
    files_parsed BIGINT DEFAULT 0,
    files_skipped BIGINT DEFAULT 0,
    malformed BIGINT DEFAULT 0,
    malformed_details JSON,
    duration_ms BIGINT,
    cleanup BOOLEAN DEFAULT false,
    status VARCHAR NOT NULL,
    error VARCHAR
);

CREATE TABLE IF NOT EXISTS sync_state (
    source_path VARCHAR PRIMARY KEY,
    source_kind VARCHAR,
    source_size BIGINT,
    source_mtime TIMESTAMP,
    last_event_id VARCHAR,
    last_line BIGINT,
    synced_at TIMESTAMP
);

-- Reserved for future additive migrations. The initial schema is applied by
-- the initializer; later versions can be applied without changing the DB
-- location or importer contract.
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TIMESTAMP DEFAULT current_timestamp,
    description VARCHAR NOT NULL
);

INSERT INTO schema_migrations (version, description)
VALUES (1, 'initial native AI session schema')
ON CONFLICT (version) DO NOTHING;

CREATE INDEX IF NOT EXISTS events_session_idx ON events(session_id);
CREATE INDEX IF NOT EXISTS events_parent_idx ON events(parent_event_id);
CREATE INDEX IF NOT EXISTS messages_session_time_idx ON messages(session_id, timestamp);
CREATE INDEX IF NOT EXISTS messages_role_idx ON messages(role);
CREATE INDEX IF NOT EXISTS tool_calls_session_idx ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS tool_results_session_idx ON tool_results(session_id);

-- Transitional shape for llm_json/render_chat/select_chat. The native tables
-- remain canonical; this view is deliberately read-only and can be removed
-- once those consumers have migrated to the event model.
CREATE OR REPLACE VIEW conversation_responses AS
SELECT
    session_id AS conversation_id,
    message_id AS response_id,
    model,
    timestamp AS datetime_utc,
    NULL::VARCHAR AS prompt,
    content AS response,
    thinking,
    input_tokens,
    output_tokens,
    stop_reason,
    duration_ms,
    token_details,
    (SELECT coalesce(json_group_array(json_object(
      'id', tc.tool_call_id,
      'name', tc.tool_name,
      'arguments', tc.arguments,
      'result', (SELECT coalesce(json_group_array(json_object('output', tr.output, 'error', tr.error)), '[]'::JSON)
                 FROM tool_results tr WHERE tr.tool_call_id = tc.tool_call_id)
    )), '[]'::JSON) FROM tool_calls tc WHERE tc.event_id = messages.event_id) AS tool_calls
FROM messages
WHERE role = 'assistant';
