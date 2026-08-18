{ jq, ... }:

# JQ module with utility functions for formatting and displaying chat data
{
  mod =
    jq.module # jq
      ''
        def header($level; $title; $text): "\(repeat_s($level; "#")) \($title)", $text;
        def header($title; $text): header(1; $title; $text);

        def labelled_message:
          (header("Prompt"; .prompt | strings // "---")),
          (if (.thinking // "") != "" then header("Thinking"; .thinking) else empty end),
          (header("Response"; .response)),
          (if ((.tool_calls // []) | length) > 0 then
             header("Tools"; (.tool_calls | map(
               "\(.name): \(.arguments)" +
               (if ((.results // []) | length) > 0 then
                  "\n" + (.results | map(.output // .error // "") | join("\n"))
                else "" end)
             ) | join("\n\n")))
           else empty end)
          ;

        def relative_time:
          (strptime("%Y-%m-%dT%H:%M:%S") | mktime) as $timestamp |
          ($timestamp - now) as $diff_seconds |
          ($diff_seconds | abs) as $diff_abs |

          # Determine the appropriate unit based on magnitude
          if ($diff_abs) >= 604800 then  # weeks (7*24*60*60)
            { unit: "w", value: ($diff_seconds / 604800 | floor) }
          elif ($diff_abs) >= 86400 then  # days (24*60*60)
            { unit: "d", value: ($diff_seconds / 86400 | floor) }
          elif ($diff_abs) >= 3600 then  # hours (60*60)
            { unit: "h", value: ($diff_seconds / 3600 | floor) }
          elif ($diff_abs) >= 60 then  # minutes
            { unit: "m", value: ($diff_seconds / 60 | floor) }
          else  # seconds
            { unit: "s", value: ($diff_seconds | floor) }
          end;

        def format_time:
          (.value | abs) as $abv |
          (if .value < 0 then "ago" else "from now" end) as $suffix |
          "\($abv)\(.unit) \($suffix)"
          ;

        def first_line: strings[:200] | gsub("\n"; " "; "g");
        def renderFzf:
          .id as $id
          | .responses[0]
          | (.datetime_utc | relative_time | format_time) as $time
          | (.prompt | first_line // "---") as $prompt
          | [$id, $time, $prompt] | join("\t");

        def chats: .;
      ''
      [
        jq.lib.string
        jq.lib.collection
      ];
}
