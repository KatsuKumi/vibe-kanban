use std::time::Duration;

use thiserror::Error;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

const CLAUDE_CODE_PACKAGE: &str = "npx -y @anthropic-ai/claude-code@2.1.32";

const DEFAULT_SYSTEM_PROMPT: &str = "\
Generate a concise git commit message for the following code changes.
Rules:
- First line: [Type] brief summary (under 72 chars). Types: Feature, Fix, Refactor, Cleanup, UI, UX, Security, Docs, Test
- Optional body: 1-3 bullet points of key changes after a blank line
- Focus on WHAT changed and WHY, not HOW
- Do not include file paths unless essential
- The task title is provided for context about intent
- Output ONLY the commit message, nothing else";

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

    let mut user_prompt = format!("Task: {task_title}\n");
    if let Some(desc) = task_description {
        let trimmed = desc.trim();
        if !trimmed.is_empty() {
            user_prompt.push_str(&format!("Description: {trimmed}\n"));
        }
    }
    user_prompt.push_str("\nDiff:\n");
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

    let message = String::from_utf8_lossy(&output.stdout).trim().to_string();

    if message.is_empty() {
        return Err(CommitMessageError::EmptyOutput);
    }

    Ok(message)
}
