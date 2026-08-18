{ ... }:
{
  # Compatibility query projection; conversation_responses is the canonical schema view.
  # Native DuckDB query. llm_json prepares this statement and binds the
  # conversation id at execution time. User messages are paired with the
  # nearest preceding user event, which works for both imported llm rows and
  # Pi trees.
  query = # sql
    ''
      COPY (
        WITH assistant_messages AS (
        SELECT
          m.*,
          s.name AS session_name,
          s.system_prompt,
          s.source,
          e.sequence AS event_sequence,
          (
            SELECT u.content
            FROM messages u
            LEFT JOIN events ue ON ue.event_id = u.event_id
            WHERE u.session_id = m.session_id
              AND u.role = 'user'
              AND coalesce(ue.sequence, 0) <= coalesce(e.sequence, 0)
            ORDER BY coalesce(ue.sequence, 0) DESC, u.timestamp DESC
            LIMIT 1
          ) AS prompt
        FROM messages m
        JOIN sessions s ON s.session_id = m.session_id
        LEFT JOIN events e ON e.event_id = m.event_id
        WHERE m.role = 'assistant'
          AND (m.session_id = $1
               OR m.session_id = 'pi:' || $1
               OR m.session_id = 'llm:' || $1
               OR length($1) = 0)
      )
        SELECT json_object(
          'id', session_id,
          'name', session_name,
          'source', source,
          'system', max(system_prompt),
          'model', max(model),
          'responses', to_json(list(
            json_object(
              'id', message_id,
              'parent_response_id', parent_event_id,
              'model', model,
              'prompt', prompt,
              'response', content,
              'thinking', thinking,
              'datetime_utc', strftime(timestamp, '%Y-%m-%dT%H:%M:%S'),
              'input_tokens', input_tokens,
              'output_tokens', output_tokens,
              'stop_reason', stop_reason,
              'duration_ms', duration_ms,
              'token_details', token_details,
              'tool_calls', coalesce((
                SELECT json_group_array(json_object(
                  'id', tc.tool_call_id,
                  'name', tc.tool_name,
                  'arguments', tc.arguments,
                  'results', coalesce((SELECT json_group_array(json_object('output', tr.output, 'error', tr.error))
                                      FROM tool_results tr WHERE tr.tool_call_id = tc.tool_call_id), '[]'::JSON)
                ))
                FROM tool_calls tc WHERE tc.event_id = assistant_messages.event_id
              ), '[]'::JSON)
            ) ORDER BY timestamp NULLS LAST, event_sequence NULLS LAST
          ))
        ) AS conversation
        FROM assistant_messages
        GROUP BY session_id, session_name, source
        ORDER BY min(timestamp) DESC NULLS LAST
      ) TO '/dev/stdout' (FORMAT JSON);
    '';

  # Initial native search uses case-insensitive token matching. This avoids
  # depending on an extension while the normalized schema remains portable;
  # __SEARCH_QUERY__ and __LIMIT__ are substituted by llm_search.
  searchQuery = # sql
    ''
      COPY (
        SELECT json_object(
          'conversation_id', m.session_id,
          'source', s.source,
          'message_id', m.message_id,
          'role', m.role,
          'model', m.model,
          'datetime_utc', strftime(m.timestamp, '%Y-%m-%dT%H:%M:%S'),
          'content', m.content,
          'thinking', m.thinking,
          'tool_name', (SELECT string_agg(tool_name, ', ') FROM tool_calls tc WHERE tc.event_id = m.event_id),
          'snippet', CASE
            WHEN position(lower('__SEARCH_QUERY__') IN lower(coalesce(m.content, ''')) > 0 THEN m.content
            WHEN position(lower('__SEARCH_QUERY__') IN lower(coalesce(m.thinking, ''')) > 0 THEN m.thinking
            ELSE coalesce((SELECT min(tc.arguments) FROM tool_calls tc WHERE tc.event_id = m.event_id),
                          (SELECT min(tr.output) FROM tool_results tr JOIN tool_calls tc ON tc.tool_call_id = tr.tool_call_id WHERE tc.event_id = m.event_id))
          END,
          'score', CASE
            WHEN lower(m.content) = lower('__SEARCH_QUERY__') OR lower(m.thinking) = lower('__SEARCH_QUERY__') THEN 3.0
            WHEN position(lower('__SEARCH_QUERY__') IN lower(coalesce(m.content, ''') || ' ' || coalesce(m.thinking, ''')) = 1 THEN 2.0
            ELSE 1.0 END
        ) AS result
        FROM messages m
        JOIN sessions s ON s.session_id = m.session_id
        WHERE position(lower('__SEARCH_QUERY__') IN lower(
          coalesce(m.content, ''') || ' ' || coalesce(m.thinking, ''') || ' ' ||
          coalesce((SELECT string_agg(tc.tool_name || ' ' || tc.arguments, ' ') FROM tool_calls tc WHERE tc.event_id = m.event_id), ''') || ' ' ||
          coalesce((SELECT string_agg(tr.output || ' ' || tr.error, ' ') FROM tool_results tr JOIN tool_calls tc ON tc.tool_call_id = tr.tool_call_id WHERE tc.event_id = m.event_id), ''')
        )) > 0
        ORDER BY m.timestamp DESC NULLS LAST
        LIMIT __LIMIT__
      ) TO '/dev/stdout' (FORMAT JSON);
    '';
}
