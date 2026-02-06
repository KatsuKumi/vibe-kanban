use std::time::Duration;

use thiserror::Error;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

const CLAUDE_CODE_PACKAGE: &str = "npx -y @anthropic-ai/claude-code@2.1.32";

const DEFAULT_SYSTEM_PROMPT: &str = "\
You are a git commit message generator. Output ONLY the raw commit message text. \
No preamble, no explanation, no quotes, no markdown fences, no surrounding text.

Format:
[Type] Short summary (max 72 chars)

- Key change 1
- Key change 2

Types: Feature, Fix, Refactor, Cleanup, UI, UX, Security, Docs, Test

Rules:
- First line MUST start with [Type] immediately — no text before it
- Focus on WHAT changed and WHY
- 1-3 optional bullet points after a blank line
- No file paths unless essential
- The task title provides context about intent

Example input task: \"Fix login redirect bug\"
Example output:
[Fix] Resolve login redirect to correct authentication page

- Replace hardcoded login path with framework route
- Update component to use client-side navigation";

pub const DEFAULT_COMMIT_MESSAGE_PROMPT: &str = DEFAULT_SYSTEM_PROMPT;

#[derive(Debug, Error)]
pub enum CommitMessageError {
    #[error("npx executable not found")]
    ExecutableNotFound,
    #[error("process failed: {0}")]
    ProcessFailed(String),
    #[error("timed out waiting for commit message generation")]
    Timeout,
    #[error("empty output from commit message generation")]
    EmptyOutput,
}

pub async fn generate_commit_message(
    diff_text: &str,
    task_title: &str,
    task_description: Option<&str>,
    custom_system_prompt: Option<&str>,
) -> Result<String, CommitMessageError> {
    let npx_path = utils::shell::resolve_executable_path("npx")
        .await
        .ok_or(CommitMessageError::ExecutableNotFound)?;

    let system_prompt = custom_system_prompt.unwrap_or(DEFAULT_SYSTEM_PROMPT);

    let mut user_prompt = format!("Generate a commit message for the following changes.\n\nTask: {task_title}\n");
    if let Some(desc) = task_description {
        let trimmed = desc.trim();
        if !trimmed.is_empty() {
            user_prompt.push_str(&format!("Description: {trimmed}\n"));
        }
    }
    user_prompt.push_str("\n--- Code changes ---\n");
    user_prompt.push_str(diff_text);

    let base_args: Vec<&str> = CLAUDE_CODE_PACKAGE.split_whitespace().skip(1).collect();

    let temp_dir = tempfile::TempDir::new().map_err(|e| {
        CommitMessageError::ProcessFailed(format!("failed to create temp dir: {e}"))
    })?;

    let system_prompt_path = temp_dir.path().join("system_prompt.txt");
    tokio::fs::write(&system_prompt_path, system_prompt)
        .await
        .map_err(|e| {
            CommitMessageError::ProcessFailed(format!("failed to write system prompt file: {e}"))
        })?;

    let mut cmd = Command::new(&npx_path);
    cmd.args(&base_args)
        .arg("--print")
        .arg("--model")
        .arg("haiku")
        .arg("--no-session-persistence")
        .arg("--system-prompt-file")
        .arg(&system_prompt_path)
        .current_dir(temp_dir.path())
        .env("NPM_CONFIG_LOGLEVEL", "error")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| CommitMessageError::ProcessFailed(e.to_string()))?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(user_prompt.as_bytes()).await;
        drop(stdin);
    }

    let output = tokio::time::timeout(Duration::from_secs(60), child.wait_with_output())
        .await
        .map_err(|_| CommitMessageError::Timeout)?
        .map_err(|e| CommitMessageError::ProcessFailed(e.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(CommitMessageError::ProcessFailed(format!(
            "exit code {}: {}",
            output.status.code().unwrap_or(-1),
            stderr.trim()
        )));
    }

    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();

    if raw.is_empty() {
        return Err(CommitMessageError::EmptyOutput);
    }

    Ok(strip_preamble(&raw))
}

fn strip_preamble(raw: &str) -> String {
    let lines: Vec<&str> = raw.lines().collect();

    if let Some(start) = lines.iter().position(|l| l.starts_with('[')) {
        return lines[start..].join("\n");
    }

    let trimmed = raw.trim();
    let preamble_markers = [
        "here's the commit message",
        "here is the commit message",
        "commit message:",
        "```",
    ];

    for marker in &preamble_markers {
        if let Some(pos) = trimmed.to_lowercase().find(marker) {
            let after = trimmed[pos + marker.len()..]
                .trim_start_matches(['\n', '\r', ':', ' '])
                .trim_end_matches("```")
                .trim();
            if !after.is_empty() {
                return after.to_string();
            }
        }
    }

    trimmed.to_string()
}
