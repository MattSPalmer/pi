use std::path::{Path, PathBuf};

const MAX_PATH_BYTES: usize = 4096;

/// Public validation deliberately collapses all failures to `false`.
pub fn validate(value: &str, cwd: &Path) -> bool {
    validate_with_root(value, cwd, None)
}

pub fn validate_with_root(value: &str, cwd: &Path, root: Option<&Path>) -> bool {
    let Some(path) = parse(value) else {
        return false;
    };
    let lexical = if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    };
    let Ok(canonical) = std::fs::canonicalize(lexical) else {
        return false;
    };
    if let Some(root) = root {
        let Ok(root) = std::fs::canonicalize(root) else {
            return false;
        };
        if canonical != root && !canonical.starts_with(root.join("")) {
            return false;
        }
    }
    acceptable_object(&canonical)
}

fn parse(value: &str) -> Option<PathBuf> {
    if value.is_empty() || value.len() > MAX_PATH_BYTES || value.chars().any(char::is_control) {
        return None;
    }
    // A path grant accepts literal paths only, never globs, regexes, or
    // stream-address expressions.  Slash, dot, spaces, and parentheses are
    // otherwise valid filename characters; existence is checked later.
    if value
        .chars()
        .any(|c| matches!(c, '*' | '?' | '[' | ']' | '{' | '}' | '^' | '$' | '|'))
    {
        return None;
    }
    if value.contains("/,/") || (value != "/" && value.starts_with('/') && value.ends_with('/')) {
        return None;
    }
    if value.starts_with("~") {
        return None; // callers must expand home paths before validation
    }
    Some(PathBuf::from(value))
}

fn acceptable_object(path: &Path) -> bool {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata.file_type().is_file() || metadata.file_type().is_dir(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("file.txt"), "x").unwrap();
        fs::create_dir(dir.path().join("nested")).unwrap();
        let path = dir.path().to_path_buf();
        (dir, path)
    }

    #[test]
    fn accepts_existing_files_and_directories() {
        let (_tmp, cwd) = fixture();
        assert!(validate("file.txt", &cwd));
        assert!(validate("nested", &cwd));
        assert!(validate("./nested/../file.txt", &cwd));
    }

    #[test]
    fn rejects_missing_and_opaque_candidates() {
        let (_tmp, cwd) = fixture();
        for value in [
            "missing",
            "*.txt",
            "foo[ab]",
            "^foo$",
            "foo|bar",
            "/^diff --git a\\/.circleci\\/config.yml/,/^diff --git a\\/(D|G|c)",
        ] {
            assert!(!validate(value, &cwd), "accepted {value}");
        }
    }

    #[test]
    fn enforces_canonical_root_containment() {
        let (_tmp, cwd) = fixture();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret"), "x").unwrap();
        assert!(validate_with_root("file.txt", &cwd, Some(&cwd)));
        assert!(!validate_with_root(
            outside.path().join("secret").to_str().unwrap(),
            &cwd,
            Some(&cwd)
        ));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path().join("secret"), cwd.join("escape")).unwrap();
            assert!(!validate_with_root("escape", &cwd, Some(&cwd)));
        }
    }

    #[test]
    fn all_invalid_inputs_have_the_same_public_result() {
        let (_tmp, cwd) = fixture();
        for value in ["", "missing", "*.txt", "^regex$", "foo\nbar"] {
            assert!(!validate(value, &cwd));
        }
    }

    #[test]
    fn rejects_special_files_and_dangling_links() {
        let (_tmp, cwd) = fixture();
        #[cfg(unix)]
        std::os::unix::fs::symlink("missing", cwd.join("dangling")).unwrap();
        assert!(!validate("dangling", &cwd));
    }
}
