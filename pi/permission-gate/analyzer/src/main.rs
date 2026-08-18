use anyhow::Result;
use serde::Serialize;
use std::io::{self, Read};
use tree_sitter::{Node, Parser};

mod audit;
mod path_validation;

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum Output {
    Ok { commands: Vec<Command> },
    Opaque { reason: String },
}
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub(crate) struct ArgumentMetadata {
    /// True when the shell source used a quoted string for this argument.
    pub(crate) shell_quoted: bool,
    /// True when the shell source used a backslash escape for this argument.
    pub(crate) shell_escaped: bool,
}

#[derive(Serialize, Debug, PartialEq)]
pub(crate) struct Command {
    pub(crate) argv: Vec<String>,
    /// Parallel to `argv`; retained separately so existing consumers can keep
    /// using the stable string argv representation.
    pub(crate) argv_metadata: Vec<ArgumentMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    separator_before: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    redirects: Vec<String>,
}

fn main() -> Result<()> {
    if std::env::args().nth(1).as_deref() == Some("audit") {
        audit::run(std::env::args().skip(2).collect())?;
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("reconstruct-sessions") {
        audit::reconstruct_sessions(std::env::args().skip(2).collect())?;
        return Ok(());
    }
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() == Some("--validate-path") {
        let path = args.next().unwrap_or_default();
        let cwd = args.next().unwrap_or_default();
        let root = args.next();
        // Deliberately return only a boolean.  Callers must not learn whether a
        // candidate was malformed, absent, inaccessible, or outside the root.
        let valid = path_validation::validate_with_root(
            &path,
            std::path::Path::new(&cwd),
            root.as_deref().map(std::path::Path::new),
        );
        println!("{{\"valid\":{valid}}}");
        return Ok(());
    }
    let input = if let Some(argument) = std::env::args().nth(1) {
        argument
    } else {
        let mut s = String::new();
        io::stdin().read_to_string(&mut s)?;
        s
    };
    println!("{}", serde_json::to_string(&analyze(&input))?);
    Ok(())
}

pub(crate) fn analyze(source: &str) -> Output {
    let mut parser = Parser::new();
    if let Err(e) = parser.set_language(&tree_sitter_bash::LANGUAGE.into()) {
        return Output::Opaque {
            reason: format!("language initialization failed: {e}"),
        };
    }
    let Some(tree) = parser.parse(source, None) else {
        return Output::Opaque {
            reason: "parser returned no tree".into(),
        };
    };
    if tree.root_node().has_error() {
        return Output::Opaque {
            reason: "shell syntax contains parser errors".into(),
        };
    }
    match extract_commands(tree.root_node(), source.as_bytes()) {
        Ok(commands) if !commands.is_empty() => Output::Ok { commands },
        Ok(_) => Output::Opaque {
            reason: "no static commands found".into(),
        },
        Err(reason) => Output::Opaque { reason },
    }
}
fn extract_commands(root: Node<'_>, source: &[u8]) -> Result<Vec<Command>, String> {
    let mut out = Vec::new();
    walk(root, source, &mut out, None)?;
    Ok(out)
}

fn static_text<'a>(node: Node<'a>, source: &[u8]) -> Result<String, String> {
    Ok(static_argument(node, source)?.0)
}

fn static_argument<'a>(
    node: Node<'a>,
    source: &[u8],
) -> Result<(String, ArgumentMetadata), String> {
    let text = node
        .utf8_text(source)
        .map_err(|_| "invalid UTF-8 in shell input".to_string())?;
    // Dollar signs and backticks are literal inside single quotes (`raw_string`).
    // Reject them everywhere else, where they can introduce shell expansion.
    if node.kind() != "raw_string" && (text.contains('$') || text.contains('`')) {
        return Err("dynamic expansion is opaque".into());
    }
    match node.kind() {
        // command_name can wrap a quoted, escaped, or concatenated expression.
        "command_name" => {
            let mut cursor = node.walk();
            if let Some(child) = node.children(&mut cursor).find(|child| child.is_named()) {
                return static_argument(child, source);
            }
            Ok((unquote(text), metadata_for_source(text, false)))
        }
        "word" | "string" | "raw_string" | "number" => Ok((
            unquote(text),
            metadata_for_source(text, matches!(node.kind(), "string" | "raw_string")),
        )),
        "concatenation" => {
            let mut cursor = node.walk();
            let mut combined = String::new();
            let mut metadata = ArgumentMetadata::default();
            for part in node.children(&mut cursor) {
                if !part.is_named() {
                    continue;
                }
                let (value, part_metadata) = static_argument(part, source)?;
                combined.push_str(&value);
                metadata.shell_quoted |= part_metadata.shell_quoted;
                metadata.shell_escaped |= part_metadata.shell_escaped;
            }
            Ok((combined, metadata))
        }
        other => Err(format!("unsupported command construct: {other}")),
    }
}

fn metadata_for_source(source: &str, quoted_node: bool) -> ArgumentMetadata {
    ArgumentMetadata {
        shell_quoted: quoted_node,
        shell_escaped: has_shell_escape(source),
    }
}

fn has_shell_escape(source: &str) -> bool {
    let mut in_single_quotes = false;
    let mut escaped = false;
    for character in source.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\'' {
            in_single_quotes = !in_single_quotes;
        } else if character == '\\' && !in_single_quotes {
            return true;
        }
    }
    false
}

// A redirect destination is opaque if dynamic; fd duplications
// (`2>&1`, plain numbers) carry no filesystem target.
fn redirect_target(node: Node<'_>, source: &[u8]) -> Result<Option<String>, String> {
    let mut cursor = node.walk();
    let mut destination = None;
    for child in node.children(&mut cursor) {
        if child.is_named() && child.kind() != "file_descriptor" {
            destination = Some(child);
        }
    }
    let Some(destination) = destination else {
        return Ok(None);
    };
    if destination.kind() == "number" {
        return Ok(None);
    }
    let text = static_text(destination, source)?;
    if text.is_empty() || text.chars().all(|c| c.is_ascii_digit()) {
        return Ok(None);
    }
    Ok(Some(text))
}

fn walk(
    node: Node<'_>,
    source: &[u8],
    out: &mut Vec<Command>,
    separator: Option<String>,
) -> Result<(), String> {
    if matches!(
        node.kind(),
        "subshell"
            | "function_definition"
            | "heredoc_redirect"
            | "command_substitution"
            | "process_substitution"
    ) {
        return Err(format!("unsupported shell construct: {}", node.kind()));
    }
    if node.kind() == "pipeline" {
        let mut cursor = node.walk();
        let mut first = true;
        for child in node.children(&mut cursor) {
            if !child.is_named() {
                continue;
            }
            let sep = if first {
                separator.clone()
            } else {
                Some("|".to_string())
            };
            first = false;
            walk(child, source, out, sep)?;
        }
        return Ok(());
    }
    if node.kind() == "redirected_statement" {
        let start = out.len();
        let mut redirects = Vec::new();
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            match child.kind() {
                "file_redirect" => {
                    if let Some(target) = redirect_target(child, source)? {
                        redirects.push(target);
                    }
                }
                "heredoc_redirect" | "herestring_redirect" => {
                    return Err("here-documents are opaque".into())
                }
                _ if child.is_named() => walk(child, source, out, separator.clone())?,
                _ => {}
            }
        }
        if out.len() == start {
            return Err("redirection has no statically known command".into());
        }
        out.last_mut()
            .expect("non-empty")
            .redirects
            .extend(redirects);
        return Ok(());
    }
    if node.kind() == "command" {
        let mut cursor = node.walk();
        let mut argv = Vec::new();
        let mut argv_metadata = Vec::new();
        let mut redirects = Vec::new();
        for child in node.children(&mut cursor) {
            match child.kind() {
                "command_name" | "word" | "string" | "raw_string" | "number" | "concatenation" => {
                    let (value, metadata) = static_argument(child, source)?;
                    argv.push(value);
                    argv_metadata.push(metadata);
                }
                "file_redirect" => {
                    if let Some(target) = redirect_target(child, source)? {
                        redirects.push(target);
                    }
                }
                "heredoc_redirect" | "herestring_redirect" => {
                    return Err("here-documents are opaque".into())
                }
                "comment" => {}
                other if child.is_named() => {
                    return Err(format!("unsupported command construct: {other}"))
                }
                _ => {}
            }
        }
        if argv.is_empty() {
            return Err("command has no statically known argv".into());
        }
        out.push(Command {
            argv,
            argv_metadata,
            separator_before: separator,
            redirects,
        });
        return Ok(());
    }
    let mut cursor = node.walk();
    let mut previous_end = None;
    for child in node.children(&mut cursor) {
        let next = previous_end
            .and_then(|end| source.get(end..child.start_byte()))
            .and_then(|b| {
                let t = String::from_utf8_lossy(b);
                ["&&", "||", ";"]
                    .iter()
                    .find(|op| t.contains(**op))
                    .map(|op| (*op).to_string())
            })
            .or_else(|| separator.clone());
        walk(child, source, out, next)?;
        if child.is_named() {
            previous_end = Some(child.end_byte());
        }
    }
    Ok(())
}
fn unquote(text: &str) -> String {
    text.strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .or_else(|| text.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
        .unwrap_or(text)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commands(source: &str) -> Vec<Command> {
        match analyze(source) {
            Output::Ok { commands } => commands,
            Output::Opaque { reason } => panic!("expected static commands, got opaque: {reason}"),
        }
    }

    #[test]
    fn preserves_shell_syntax_metadata_alongside_argv() {
        let command =
            commands(r##"printf bare "quoted value" 'raw value' escaped\ value joined"suffix""##)
                .pop()
                .unwrap();

        assert_eq!(
            command.argv,
            [
                "printf",
                "bare",
                "quoted value",
                "raw value",
                "escaped\\ value",
                "joinedsuffix"
            ]
        );
        assert_eq!(
            command.argv_metadata,
            [
                ArgumentMetadata::default(),
                ArgumentMetadata::default(),
                ArgumentMetadata {
                    shell_quoted: true,
                    shell_escaped: false
                },
                ArgumentMetadata {
                    shell_quoted: true,
                    shell_escaped: false
                },
                ArgumentMetadata {
                    shell_quoted: false,
                    shell_escaped: true
                },
                ArgumentMetadata {
                    shell_quoted: true,
                    shell_escaped: false
                },
            ]
        );
        assert_eq!(command.argv.len(), command.argv_metadata.len());
    }

    #[test]
    fn metadata_is_preserved_for_each_command_in_a_compound_input() {
        let commands = commands(r##"echo bare && echo "quoted""##);
        assert_eq!(commands.len(), 2);
        assert_eq!(
            commands[0].argv_metadata,
            [ArgumentMetadata::default(), ArgumentMetadata::default()]
        );
        assert_eq!(
            commands[1].argv_metadata[1],
            ArgumentMetadata {
                shell_quoted: true,
                shell_escaped: false
            }
        );
    }

    #[test]
    fn single_quoted_expansion_syntax_is_literal_and_keeps_compound_commands_split() {
        let commands = commands(
            r#"jj status; printf '\nfiles:\n'; fd pattern . -x sh -c 'echo --- $0; head -100 "$0"'"#,
        );
        assert_eq!(commands.len(), 3);
        assert_eq!(commands[0].argv, ["jj", "status"]);
        assert_eq!(commands[1].argv, ["printf", "\\nfiles:\\n"]);
        assert_eq!(commands[2].argv[0], "fd");
        assert_eq!(
            commands[2].argv.last().unwrap(),
            "echo --- $0; head -100 \"$0\""
        );
    }

    #[test]
    fn unquoted_and_double_quoted_expansions_remain_opaque() {
        for source in [r#"echo $HOME"#, r#"echo "$HOME""#, "echo `pwd`"] {
            assert!(
                matches!(analyze(source), Output::Opaque { .. }),
                "{source} must remain opaque"
            );
        }
    }
}
