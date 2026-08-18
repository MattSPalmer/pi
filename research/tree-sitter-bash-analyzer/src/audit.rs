use crate::{analyze, Command, Output};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Default)]
struct Options {
    log: Option<PathBuf>,
    top: usize,
    help: bool,
    sequence_length: usize,
    session: Option<String>,
    since: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PermissionRecord {
    timestamp: Option<String>,
    session: Option<String>,
    tool: Option<String>,
    request: Option<String>,
    decision: Option<String>,
    prompted: Option<bool>,
    prompt_count: Option<u64>,
    evaluation_inferred: Option<bool>,
}

#[derive(Clone, Debug)]
struct EventSample {
    record_index: usize,
    timestamp: String,
    session: String,
    prompted: bool,
    decision: Option<String>,
    prompt_count: u64,
    commands: Vec<NormalizedCommand>,
}

#[derive(Clone, Debug)]
struct NormalizedCommand {
    base: BaseKey,
    first_positional: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
struct BaseKey {
    head: String,
    flags: Vec<(String, u32)>,
    slots: usize,
}

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
struct FinalKey {
    base: BaseKey,
    first_literal: Option<String>,
}

#[derive(Default)]
struct CandidateAccumulator {
    occurrences: usize,
    events: BTreeSet<usize>,
    prompted: usize,
    accepted: usize,
    denied: usize,
    prompt_count: u64,
}

#[derive(Default)]
struct SequenceAccumulator {
    occurrences: usize,
    sessions: BTreeSet<String>,
}

#[derive(Serialize)]
struct Report {
    source: SourceSummary,
    metrics: Metrics,
    candidates: Vec<Candidate>,
    sequences: Vec<Sequence>,
}

#[derive(Serialize)]
struct SourceSummary {
    log: String,
    records: usize,
    parse_errors: usize,
    denominator_complete: bool,
    sequence_length: usize,
}

#[derive(Serialize)]
struct Metrics {
    evaluated_events: usize,
    prompted_events: usize,
    prompt_count: u64,
    accepted_prompts: usize,
    denied_events: usize,
    prompt_rate: Option<f64>,
    accept_ratio: Option<f64>,
}

#[derive(Serialize)]
struct Candidate {
    key: String,
    head: String,
    flags: Vec<String>,
    positional_slots: usize,
    promoted_first_positional: Option<String>,
    command_occurrences: usize,
    evaluated_events: usize,
    prompted_events: usize,
    prompt_count: u64,
    accepted_prompts: usize,
    denied_events: usize,
    prompt_rate: Option<f64>,
    accept_ratio: Option<f64>,
}

#[derive(Serialize)]
struct Sequence {
    commands: Vec<String>,
    occurrences: usize,
    sessions: usize,
}

pub(crate) fn reconstruct_sessions(arguments: Vec<String>) -> Result<()> {
    let mut sessions = None;
    let mut output = None;
    let mut args = arguments.into_iter();
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--sessions" => {
                sessions = Some(PathBuf::from(
                    args.next().context("--sessions needs a path")?,
                ))
            }
            "--output" => {
                output = Some(PathBuf::from(args.next().context("--output needs a path")?))
            }
            "-h" | "--help" => {
                println!("usage: tree-sitter-bash-analyzer reconstruct-sessions --sessions PATH [--output PATH]");
                return Ok(());
            }
            other => bail!("unknown reconstruct-sessions option: {other}"),
        }
    }
    let sessions = sessions.context("--sessions is required")?;
    let mut files = Vec::new();
    collect_jsonl_files(&sessions, &mut files)?;
    files.sort();
    let mut records = Vec::new();
    for file in files {
        let text = fs::read_to_string(&file)
            .with_context(|| format!("failed to read {}", file.display()))?;
        let mut session_id = file
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string();
        for line in text.lines() {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            if value.get("type").and_then(|v| v.as_str()) == Some("session") {
                if let Some(id) = value.get("id").and_then(|v| v.as_str()) {
                    session_id = id.to_string();
                }
            }
            if value.get("type").and_then(|v| v.as_str()) != Some("message")
                || value.pointer("/message/role").and_then(|v| v.as_str()) != Some("assistant")
            {
                continue;
            }
            let Some(timestamp) = value.get("timestamp").and_then(|v| v.as_str()) else {
                continue;
            };
            let Some(parts) = value.pointer("/message/content").and_then(|v| v.as_array()) else {
                continue;
            };
            for call in parts
                .iter()
                .filter(|part| part.get("type").and_then(|v| v.as_str()) == Some("toolCall"))
            {
                let Some(tool) = call.get("name").and_then(|v| v.as_str()) else {
                    continue;
                };
                if !is_audited_tool(tool) {
                    continue;
                }
                let request = call
                    .pointer("/arguments/command")
                    .and_then(|v| v.as_str())
                    .or_else(|| call.pointer("/arguments/path").and_then(|v| v.as_str()));
                let Some(request) = request else { continue };
                records.push(serde_json::json!({
                    "audit_version": 1,
                    "event": "session_tool_call",
                    "source": "session-history",
                    "evaluation_inferred": true,
                    "timestamp": timestamp,
                    "session": session_id,
                    "tool": tool,
                    "request": request,
                    "prompted": serde_json::Value::Null,
                    "decision": "unknown",
                    "disposition": "unknown"
                }));
            }
        }
    }
    let has_records = !records.is_empty();
    let text = records
        .into_iter()
        .map(|record| serde_json::to_string(&record))
        .collect::<Result<Vec<_>, _>>()?
        .join("\n")
        + if has_records { "\n" } else { "" };
    if let Some(output) = output {
        fs::write(&output, text)
            .with_context(|| format!("failed to write {}", output.display()))?;
    } else {
        print!("{text}");
    }
    Ok(())
}

fn collect_jsonl_files(path: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
    if path.is_file() {
        if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            files.push(path.to_path_buf());
        }
        return Ok(());
    }
    for entry in fs::read_dir(path).with_context(|| format!("failed to read {}", path.display()))? {
        let entry = entry?;
        collect_jsonl_files(&entry.path(), files)?;
    }
    Ok(())
}

pub(crate) fn run(arguments: Vec<String>) -> Result<()> {
    let options = parse_options(arguments)?;
    if options.help {
        return Ok(());
    }
    let log = options.log.clone().unwrap_or(default_log_path()?);
    let text = fs::read_to_string(&log)
        .with_context(|| format!("failed to read permission log {}", log.display()))?;
    let (records, parse_errors) = parse_records(&text);
    let report = build_report(&records, parse_errors, &log, &options);
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn parse_options(arguments: Vec<String>) -> Result<Options> {
    let mut options = Options {
        top: 25,
        sequence_length: 2,
        ..Options::default()
    };
    let mut args = arguments.into_iter();
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--log" => {
                options.log = Some(PathBuf::from(args.next().context("--log needs a path")?))
            }
            "--top" => options.top = parse_usize("--top", args.next())?,
            "--sequence-length" => {
                options.sequence_length = parse_usize("--sequence-length", args.next())?;
                if options.sequence_length < 2 {
                    bail!("--sequence-length must be at least 2");
                }
            }
            "--session" => options.session = Some(args.next().context("--session needs an id")?),
            "--since" => {
                options.since = Some(args.next().context("--since needs an ISO timestamp")?)
            }
            "-h" | "--help" => {
                println!("usage: tree-sitter-bash-analyzer audit [--log PATH] [--top N] [--sequence-length N] [--session ID] [--since ISO_TIMESTAMP]");
                return Ok(Options {
                    help: true,
                    top: 0,
                    sequence_length: 2,
                    ..Options::default()
                });
            }
            other => bail!("unknown audit option: {other}"),
        }
    }
    Ok(options)
}

fn parse_usize(name: &str, value: Option<String>) -> Result<usize> {
    value
        .context(format!("{name} needs a number"))?
        .parse()
        .with_context(|| format!("{name} must be a number"))
}

fn default_log_path() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").context("HOME is not set; pass --log PATH")?;
    Ok(PathBuf::from(home).join(".pi/permission-requests.jsonl"))
}

fn parse_records(text: &str) -> (Vec<PermissionRecord>, usize) {
    // Older versions accidentally wrote a literal `\\n` separator. Normalize
    // only object boundaries so escaped newlines inside JSON strings survive.
    let normalized = text.replace("}\\n{", "}\n{");
    let mut records = Vec::new();
    let mut parse_errors = 0;
    for line in normalized.lines() {
        let line = line.trim_end_matches("\\n").trim();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str(line) {
            Ok(record) => records.push(record),
            Err(_) => parse_errors += 1,
        }
    }
    (records, parse_errors)
}

fn build_report(
    records: &[PermissionRecord],
    parse_errors: usize,
    log: &PathBuf,
    options: &Options,
) -> Report {
    let mut filtered: Vec<(usize, &PermissionRecord)> = records
        .iter()
        .enumerate()
        .filter(|(_, record)| record.tool.as_deref().map(is_audited_tool).unwrap_or(false))
        .filter(|(_, record)| {
            options
                .session
                .as_deref()
                .map(|session| record.session.as_deref() == Some(session))
                .unwrap_or(true)
        })
        .filter(|(_, record)| {
            options
                .since
                .as_deref()
                .map(|since| record.timestamp.as_deref().unwrap_or("") >= since)
                .unwrap_or(true)
        })
        .collect();
    filtered.sort_by_key(|(_, record)| record.timestamp.clone().unwrap_or_default());

    let denominator_complete = filtered.iter().all(|(_, record)| record.prompted.is_some());
    let evaluated_events = filtered.len();
    let prompted = |record: &PermissionRecord| {
        record.evaluation_inferred != Some(true) && record.prompted.unwrap_or(true)
    };
    let prompted_events = filtered
        .iter()
        .filter(|(_, record)| prompted(record))
        .count();
    let prompt_count = filtered
        .iter()
        .map(|(_, record)| {
            if prompted(record) {
                record.prompt_count.unwrap_or(1)
            } else {
                0
            }
        })
        .sum();
    let accepted_prompts = filtered
        .iter()
        .filter(|(_, record)| prompted(record) && record.decision.as_deref() == Some("allowed"))
        .count();
    let denied_events = filtered
        .iter()
        .filter(|(_, record)| record.decision.as_deref() == Some("denied"))
        .count();

    let mut samples = Vec::new();
    for (record_index, record) in filtered.iter().copied() {
        let Some(request) = record.request.as_deref() else {
            continue;
        };
        let commands = match analyze(request) {
            Output::Ok { commands } => commands.iter().map(normalize_command).collect(),
            Output::Opaque { .. } => Vec::new(),
        };
        if commands.is_empty() {
            continue;
        }
        samples.push(EventSample {
            record_index,
            timestamp: record.timestamp.clone().unwrap_or_default(),
            session: record
                .session
                .clone()
                .unwrap_or_else(|| format!("record-{record_index}")),
            prompted: prompted(record),
            decision: record.decision.clone(),
            prompt_count: if prompted(record) {
                record.prompt_count.unwrap_or(1)
            } else {
                0
            },
            commands,
        });
    }

    let mut first_counts: HashMap<(BaseKey, String), usize> = HashMap::new();
    for sample in &samples {
        for command in &sample.commands {
            if let Some(first) = &command.first_positional {
                *first_counts
                    .entry((command.base.clone(), first.clone()))
                    .or_default() += 1;
            }
        }
    }

    let mut candidates: BTreeMap<FinalKey, CandidateAccumulator> = BTreeMap::new();
    for sample in &samples {
        for command in &sample.commands {
            let first_literal = command.first_positional.as_ref().and_then(|first| {
                (first_counts
                    .get(&(command.base.clone(), first.clone()))
                    .copied()
                    .unwrap_or(0)
                    > 1)
                .then(|| first.clone())
            });
            let key = FinalKey {
                base: command.base.clone(),
                first_literal,
            };
            let accumulator = candidates.entry(key).or_default();
            accumulator.occurrences += 1;
            accumulator.events.insert(sample.record_index);
            if sample.prompted {
                accumulator.prompted += 1;
            }
            if sample.prompted && sample.decision.as_deref() == Some("allowed") {
                accumulator.accepted += 1;
            }
            if sample.prompted && sample.decision.as_deref() == Some("denied") {
                accumulator.denied += 1;
            }
            accumulator.prompt_count += sample.prompt_count;
        }
    }

    let mut candidate_output: Vec<Candidate> = candidates
        .into_iter()
        .filter_map(|(key, accumulator)| {
            if accumulator.prompted == 0 {
                return None;
            }
            Some(Candidate {
                key: display_key(&key),
                head: key.base.head.clone(),
                flags: key
                    .base
                    .flags
                    .iter()
                    .map(|(name, _)| name.clone())
                    .collect(),
                positional_slots: key.base.slots,
                promoted_first_positional: key.first_literal,
                command_occurrences: accumulator.occurrences,
                evaluated_events: accumulator.events.len(),
                prompted_events: accumulator.prompted,
                prompt_count: accumulator.prompt_count,
                accepted_prompts: accumulator.accepted,
                denied_events: accumulator.denied,
                prompt_rate: ratio(accumulator.prompted, accumulator.events.len()),
                accept_ratio: ratio(accumulator.accepted, accumulator.prompted),
            })
        })
        .collect();
    candidate_output.sort_by(|left, right| {
        right
            .accept_ratio
            .unwrap_or(0.0)
            .total_cmp(&left.accept_ratio.unwrap_or(0.0))
            .then_with(|| right.prompted_events.cmp(&left.prompted_events))
            .then_with(|| right.command_occurrences.cmp(&left.command_occurrences))
            .then_with(|| left.key.cmp(&right.key))
    });
    candidate_output.truncate(options.top);

    let mut sequence_counts: HashMap<Vec<String>, SequenceAccumulator> = HashMap::new();
    let mut by_session: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut sample_order = samples;
    sample_order.sort_by(|left, right| {
        left.session
            .cmp(&right.session)
            .then_with(|| left.timestamp.cmp(&right.timestamp))
    });
    for sample in &sample_order {
        let sequence = by_session.entry(sample.session.clone()).or_default();
        for command in &sample.commands {
            let first_literal = command.first_positional.as_ref().and_then(|first| {
                (first_counts
                    .get(&(command.base.clone(), first.clone()))
                    .copied()
                    .unwrap_or(0)
                    > 1)
                .then(|| first.clone())
            });
            sequence.push(display_key(&FinalKey {
                base: command.base.clone(),
                first_literal,
            }));
        }
    }
    for (session, commands) in by_session {
        if commands.len() < options.sequence_length {
            continue;
        }
        for window in commands.windows(options.sequence_length) {
            let entry = sequence_counts.entry(window.to_vec()).or_default();
            entry.occurrences += 1;
            entry.sessions.insert(session.clone());
        }
    }
    let mut sequence_output: Vec<Sequence> = sequence_counts
        .into_iter()
        .filter(|(_, value)| value.occurrences > 1)
        .map(|(commands, value)| Sequence {
            commands,
            occurrences: value.occurrences,
            sessions: value.sessions.len(),
        })
        .collect();
    sequence_output.sort_by(|left, right| {
        right
            .occurrences
            .cmp(&left.occurrences)
            .then_with(|| left.commands.cmp(&right.commands))
    });
    sequence_output.truncate(options.top);

    Report {
        source: SourceSummary {
            log: log.display().to_string(),
            records: filtered.len(),
            parse_errors,
            denominator_complete,
            sequence_length: options.sequence_length,
        },
        metrics: Metrics {
            evaluated_events,
            prompted_events,
            prompt_count,
            accepted_prompts,
            denied_events,
            prompt_rate: if denominator_complete {
                ratio(prompted_events, evaluated_events)
            } else {
                None
            },
            accept_ratio: ratio(accepted_prompts, prompted_events),
        },
        candidates: candidate_output,
        sequences: sequence_output,
    }
}

fn is_audited_tool(tool: &str) -> bool {
    tool == "bash" || matches!(tool, "read" | "edit" | "write" | "ls" | "grep" | "find")
}

fn normalize_command(command: &Command) -> NormalizedCommand {
    let mut flags: BTreeMap<String, u32> = BTreeMap::new();
    let mut positionals = Vec::new();
    let mut index = 1;
    while index < command.argv.len() {
        let token = &command.argv[index];
        if let Some(flag) = flag_name(token) {
            *flags.entry(flag.clone()).or_default() += 1;
            if !token.contains('=') && flag_takes_value(&flag) && index + 1 < command.argv.len() {
                index += 2;
            } else {
                index += 1;
            }
            continue;
        }
        let metadata = command
            .argv_metadata
            .get(index)
            .cloned()
            .unwrap_or_default();
        if !metadata.shell_quoted && !metadata.shell_escaped {
            positionals.push(token.clone());
        }
        index += 1;
    }
    let head = command.argv.first().cloned().unwrap_or_default();
    NormalizedCommand {
        base: BaseKey {
            head,
            flags: flags.into_iter().collect(),
            slots: positionals.len(),
        },
        first_positional: positionals.into_iter().next(),
    }
}

fn flag_name(token: &str) -> Option<String> {
    if token.len() < 2 || !token.starts_with('-') || token == "-" {
        return None;
    }
    Some(
        token
            .split_once('=')
            .map(|(name, _)| name)
            .unwrap_or(token)
            .to_string(),
    )
}

fn flag_takes_value(flag: &str) -> bool {
    matches!(
        flag,
        "-C" | "-I"
            | "-M"
            | "-R"
            | "-T"
            | "-b"
            | "-c"
            | "-e"
            | "-f"
            | "-g"
            | "-j"
            | "-m"
            | "-n"
            | "-o"
            | "-r"
            | "-t"
            | "-u"
            | "-w"
            | "--bookmark"
            | "--color"
            | "--config"
            | "--context"
            | "--file"
            | "--from"
            | "--glob"
            | "--ignore-file"
            | "--jobs"
            | "--message"
            | "--name"
            | "--output"
            | "--repository"
            | "--revision"
            | "--revisions"
            | "--threads"
            | "--to"
            | "--type"
    )
}

fn display_key(key: &FinalKey) -> String {
    let mut parts = vec![key.base.head.clone()];
    if let Some(first) = &key.first_literal {
        parts.push(first.clone());
    }
    let remaining_slots = key
        .base
        .slots
        .saturating_sub(usize::from(key.first_literal.is_some()));
    parts.extend(std::iter::repeat_n("<pos>".to_string(), remaining_slots));
    if !key.base.flags.is_empty() {
        parts.push(format!(
            "[{}]",
            key.base
                .flags
                .iter()
                .map(|(name, count)| if *count == 1 {
                    name.clone()
                } else {
                    format!("{name}×{count}")
                })
                .collect::<Vec<_>>()
                .join(",")
        ));
    }
    parts.join(" ")
}

fn ratio(numerator: usize, denominator: usize) -> Option<f64> {
    (denominator > 0).then(|| numerator as f64 / denominator as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> Options {
        Options {
            top: 25,
            sequence_length: 2,
            ..Options::default()
        }
    }

    #[test]
    fn legacy_literal_newline_records_are_read_and_marked_incomplete() {
        let text = r#"{"tool":"bash","request":"jj status","decision":"allowed"}\n{"tool":"bash","request":"jj diff","decision":"denied"}"#;
        let (records, errors) = parse_records(text);
        assert_eq!(records.len(), 2);
        assert_eq!(errors, 0);
        let report = build_report(
            &records,
            errors,
            &PathBuf::from("history.jsonl"),
            &options(),
        );
        assert!(!report.source.denominator_complete);
        assert_eq!(report.metrics.evaluated_events, 2);
    }

    #[test]
    fn promotes_only_repeated_first_positionals_and_scores_acceptance() {
        let text = concat!(
            r#"{"timestamp":"2026-01-01T00:00:00Z","session":"s","tool":"bash","request":"jj diff a","prompted":true,"decision":"allowed"}"#,
            "\n",
            r#"{"timestamp":"2026-01-01T00:00:01Z","session":"s","tool":"bash","request":"jj diff b","prompted":true,"decision":"allowed"}"#,
            "\n",
            r#"{"timestamp":"2026-01-01T00:00:02Z","session":"s","tool":"bash","request":"jj log c","prompted":true,"decision":"denied"}"#,
            "\n",
            r#"{"timestamp":"2026-01-01T00:00:03Z","session":"s","tool":"bash","request":"jj diff d","prompted":false,"prompt_count":0,"disposition":"allow"}"#,
            "\n",
            r#"{"timestamp":"2026-01-01T00:00:04Z","session":"s","tool":"bash","request":"jj status","prompted":false,"prompt_count":0,"disposition":"allow"}"#,
        );
        let (records, errors) = parse_records(text);
        let report = build_report(
            &records,
            errors,
            &PathBuf::from("history.jsonl"),
            &options(),
        );
        assert_eq!(report.metrics.evaluated_events, 5);
        assert_eq!(report.metrics.prompted_events, 3);
        assert_eq!(report.metrics.accepted_prompts, 2);
        assert_eq!(report.metrics.prompt_rate, Some(0.6));
        assert!(report.candidates.iter().any(
            |candidate| candidate.key == "jj diff <pos>" && candidate.accept_ratio == Some(1.0)
        ));
        assert!(report
            .candidates
            .iter()
            .any(|candidate| candidate.key == "jj <pos> <pos>"
                && candidate.accept_ratio == Some(0.0)));
    }

    #[test]
    fn repeated_normalized_commands_produce_sequences() {
        let text = concat!(
            r#"{"timestamp":"2026-01-01T00:00:00Z","session":"s","tool":"bash","request":"jj status && jj diff a","prompted":true,"decision":"allowed"}"#,
            "\n",
            r#"{"timestamp":"2026-01-01T00:00:01Z","session":"s","tool":"bash","request":"jj status && jj diff b","prompted":true,"decision":"allowed"}"#,
        );
        let (records, errors) = parse_records(text);
        let report = build_report(
            &records,
            errors,
            &PathBuf::from("history.jsonl"),
            &options(),
        );
        assert_eq!(report.sequences.len(), 1);
        assert_eq!(report.sequences[0].occurrences, 2);
    }
}
