{ pkgs, duckdb }:
let
  defaultPath = "$HOME/Library/Application Support/ai-sessions/sessions.duckdb";
  schema = pkgs.writeText "ai-session-schema.sql" (builtins.readFile ./schema.sql);
  init = pkgs.writeShellApplication {
    name = "ai_session_db_init";
    runtimeInputs = [
      pkgs.coreutils
      duckdb
    ];
    text = ''
      db_path="''${AI_SESSION_DB:-${defaultPath}}"
      mkdir -p "$(dirname "$db_path")"
      # All schema DDL is idempotent, so this is safe during profile
      # activation and when run manually.
      duckdb "$db_path" < "${schema}"
      printf 'Initialized AI session database: %s\n' "$db_path"
    '';
  };
  # Shared Python helpers are injected through PYTHONPATH. TODO: extract the
  # remaining sync implementation into ai_sessions.sync.
  piSync = pkgs.writeShellApplication {
    name = "ai_session_sync";
    runtimeInputs = [
      pkgs.python3
      duckdb
      init
    ];
    text = ''
      db_path="''${AI_SESSION_DB:-${defaultPath}}"
      mkdir -p "$(dirname "$db_path")"
      lock_dir="$db_path.sync.lock"
      if ! mkdir "$lock_dir" 2>/dev/null; then
        lock_pid=""
        [ -r "$lock_dir/pid" ] && lock_pid=$(cat "$lock_dir/pid")
        stale=0
        if [ -z "$lock_pid" ] || ! kill -0 "$lock_pid" 2>/dev/null; then
          stale=1
        fi
        if [ "$stale" -eq 1 ] && rm -rf "$lock_dir" && mkdir "$lock_dir" 2>/dev/null; then
          printf '%s\n' "$$" > "$lock_dir/pid"
        else
          printf 'ai_session_sync: another sync is already running (pid %s)\n' "''${lock_pid:-unknown}" >&2
          exit 0
        fi
      else
        printf '%s\n' "$$" > "$lock_dir/pid"
      fi
      trap 'rm -rf "$lock_dir"' EXIT
      ai_session_db_init >/dev/null
      export PYTHONPATH="${./python}:''${PYTHONPATH:-}"
      exec python3 "${./pi-session-sync.py}" "$@"
    '';
  };
  importLlm = pkgs.writeShellApplication {
    name = "ai_session_import_llm";
    runtimeInputs = [
      pkgs.coreutils
      duckdb
      init
    ];
    text = ''
      legacy_path="''${LLM_LOGS_DB:-$HOME/Library/Application Support/io.datasette.llm/logs.db}"
      db_path="''${AI_SESSION_DB:-${defaultPath}}"

      if [ ! -r "$legacy_path" ]; then
        echo "ai_session_import_llm: legacy database not readable: $legacy_path" >&2
        exit 1
      fi

      # The importer owns initialization so it is safe on a fresh checkout.
      ai_session_db_init >/dev/null
      sql=$(cat "${builtins.toFile "ai-session-import.sql" (builtins.readFile ./import-llm.sql)}")
      legacy_sql=$(printf '%s' "$legacy_path" | sed "s/$(printf '\\047')/$(printf '\\047\\047')/g")
      source_size=$(stat -f '%z' "$legacy_path")
      source_mtime=$(stat -f '%m' "$legacy_path")
      sql="''${sql//__LEGACY_PATH__/$legacy_sql}"
      sql="''${sql//__SOURCE_SIZE__/$source_size}"
      sql="''${sql//__SOURCE_MTIME__/$source_mtime}"
      duckdb "$db_path" -c "$sql"
    '';
  };
in
{
  inherit
    init
    piSync
    importLlm
    defaultPath
    ;
}
