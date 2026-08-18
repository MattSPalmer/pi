{
  pkgs,
  config,
  fzf,
  duckdb,
  ...
}:
let
  inherit (config.tools) jq;

  # Use callPackage for better dependency injection
  queries = pkgs.callPackage ./query.nix { };
  inherit (queries) query searchQuery;
  # TODO: migrate pi-session-sync.py to `python -m ai_sessions.sync`
  # after extracting its parser/state/writer responsibilities into the package.
  sessionJson = pkgs.writeShellApplication {
    name = "ai_session_json";
    runtimeInputs = [
      pkgs.python3
      duckdb
    ];
    text = ''
      export PYTHONPATH="${./python}:''${PYTHONPATH:-}"
      exec python3 "${./session-json.py}" "$@"
    '';
  };
  queryFile = pkgs.writeText "llm-duck-query.sql" query;
  searchQueryFile = pkgs.writeText "llm-duck-search.sql" searchQuery;
  mod = (pkgs.callPackage ./jq-module.nix { inherit jq; }).mod;

  # Shell application to render a chat conversation in a readable format
  renderChat = pkgs.writeShellApplication {
    name = "render_chat";
    runtimeInputs = [
      llmJson
      (jq.cmd "jq_render_chat" mod {
        args = "-r";
        expr = # jq
          ''
            .[0].responses
              | sort_by(.datetime_utc)
              | map(labelled_message)
              | join("\n\n")
          '';
      })
    ];
    text = ''
      llm_json "$1" | jq_render_chat
    '';
  };

  # Shell application to extract chat data from the LLM database as JSON
  llmJson = pkgs.writeShellApplication {
    name = "llm_json";
    runtimeInputs = [
      duckdb
      pkgs.jq
    ];
    text = ''
      query=$(cat ${queryFile})
      DB_PATH="''${AI_SESSION_DB:-$HOME/Library/Application Support/ai-sessions/sessions.duckdb}"
      id="''${1:-}"

      # Prepare the static query and bind the value at execution time. The
      # value is passed through the environment because the DuckDB CLI has no
      # command-line parameter-binding option; it never becomes SQL text.
      AI_SESSION_CONVERSATION_ID="$id" duckdb "$DB_PATH" -c \
        "PREPARE llm_json_query AS $query EXECUTE llm_json_query(getenv('AI_SESSION_CONVERSATION_ID'));" \
        | jq -c '.conversation' \
        | jq -s .
    '';
  };

  # Search the existing SQLite FTS5 index without writing to llm's database.
  llmSearch = pkgs.writeShellApplication {
    name = "llm_search";
    runtimeInputs = [
      duckdb
      pkgs.jq
    ];
    text = ''
      searchQuery=$(cat ${searchQueryFile})
      if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
        echo "usage: llm_search QUERY [LIMIT]" >&2
        exit 2
      fi

      search="$1"
      limit="''${2:-20}"
      case "$limit" in
        *[!0-9]*)
          echo "llm_search: limit must be a non-negative integer" >&2
          exit 2
          ;;
      esac

      # Escape the search string for its single SQL string literal. Native
      # search deliberately uses substring matching rather than SQLite FTS.
      escaped_search=$(printf '%s' "$search" | sed "s/$(printf '\\047')/$(printf '\\047\\047')/g")
      sql="''${searchQuery//__LIMIT__/$limit}"
      sql="''${sql//__SEARCH_QUERY__/$escaped_search}"
      DB_PATH="''${AI_SESSION_DB:-$HOME/Library/Application Support/ai-sessions/sessions.duckdb}"

      duckdb "$DB_PATH" -c "$sql" \
        | jq -c '.result' \
        | jq -s .
    '';
  };

  # JQ command to format chat IDs for display in FZF
  chatIds = jq.cmd "chat_ids" mod {
    args = "-r";
    expr = # jq
      "chats[] | renderFzf";
  };

  # Shell application to interactively select and display chat conversations
  selectChat =
    let
      render_chat = "${renderChat}/bin/render_chat";
      previewCommand = # sh
        ''
          ${render_chat} {1} | bat --wrap=auto --color=always --language=markdown
        '';
    in
    pkgs.writeShellApplication {
      name = "select_chat";
      runtimeInputs = [
        pkgs.jq
        pkgs.bat
        llmJson
        renderChat
        chatIds
        fzf
      ];
      text = ''
        llm_json "$@" \
          | chat_ids \
          | fzf --ansi \
              -d"	" --nth 2 --with-nth="{2..}	{1}" --accept-nth 1 \
              --preview '${previewCommand}' \
              --preview-window="down:80%,wrap" \
              --bind 'alt-up:preview-half-page-up' \
              --bind 'alt-down:preview-half-page-down'
      '';
    };
in
{
  inherit
    selectChat
    renderChat
    llmJson
    sessionJson
    llmSearch
    chatIds
    ;
}
