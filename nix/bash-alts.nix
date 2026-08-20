{ pkgs }:
let
  mkAlt =
    {
      displace,
      replacement,
      packages ? [ ],
      permissions ? { },
      context ? "${builtins.head displace} use is precluded entirely by ${replacement} (`${replacement} --help` if you're unfamiliar).",
    }:
    {
      inherit
        context
        displace
        packages
        permissions
        replacement
        ;
      enable = false;
    };
in
{
  git = mkAlt {
    displace = [
      "git"
      "git *"
      "*/git"
      "*/git *"
    ];
    replacement = "jj";
    packages = [ pkgs.jujutsu ];
    permissions = {
      commands.jj = {
        READ = [
          "diff"
          "evolog"
          "file list"
          "file show"
          "file search"
          "file annotate"
          "git fetch"
          "help"
          "log"
          "operation log"
          "operation diff"
          "operation show"
          "root"
          "show"
          "status"
          "version"
          "workspace list"
          "evo"
          "cm"
          "ng"
          "plain"
          "cmng"
          "np"
        ];
        WRITE = [
          "abandon"
          "absorb"
          "arrange"
          "bookmark"
          "commit"
          "describe"
          "duplicate"
          "edit"
          "file chmod"
          "file track"
          "file untrack"
          "metaedit"
          "new"
          "next"
          "operation abandon"
          "operation restore"
          "operation revert"
          "parallelize"
          "prev"
          "rebase"
          "redo"
          "resolve"
          "restore"
          "revert"
          "simplify-parents"
          "sparse"
          "split"
          "squash"
          "undo"
          "workspace add"
          "workspace forget"
          "workspace rename"
          "workspace update-stale"
          "desc"
          "e"
          "n"
        ];
        NETWORK = [
          "git clone"
          "git export"
          "git import"
          "git init"
          "git push"
          "git remote"
          "sign"
          "unsign"
        ];
        ADMIN = [ "config" ];
      };
      bash = {
        READ = [
          "jd"
          "gd"
          "jsh"
          "jgf"
          "jbl"
          "jst"
          "gst"
          "jl"
          "jdd"
        ];
        WRITE = [
          "je"
          "jn"
          "jne"
          "jsq"
          "jb"
          "jr"
          "jdc"
          "jddc"
          "jep"
          "jj_workspace_create"
          "jj_workspace_forget"
          "jj_workspace_sweep"
        ];
        NETWORK = [ "jgp" ];
      };
    };
  };

  find = mkAlt {
    displace = [
      "find"
      "find *"
    ];
    replacement = "fd";
    packages = [ pkgs.fd ];
    permissions.bash.READ = [
      "fd"
      "fd *"
    ];
  };

  grep = mkAlt {
    displace = [
      "grep"
      "grep *"
    ];
    replacement = "rg";
    packages = [ pkgs.ripgrep ];
    permissions.bash.READ = [
      "rg"
      "rg *"
    ];
  };
}
