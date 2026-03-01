use std::sync::Arc;

use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, ChildStdout},
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;

use super::types::{
    BridgeCommand, BridgeConfig, CLIMessage, ControlRequestType, ControlResponseMessage,
    ControlResponseType, Message, PermissionMode, SDKControlRequest, SDKControlRequestType,
};
use crate::{
    approvals::ExecutorApprovalError,
    executors::{ExecutorError, claude::client::ClaudeAgentClient},
};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ProtocolMode {
    Bridge,
    Cli,
}

#[derive(Clone)]
pub struct ProtocolPeer {
    stdin: Arc<Mutex<ChildStdin>>,
    mode: ProtocolMode,
}

impl ProtocolPeer {
    pub fn spawn(
        stdin: ChildStdin,
        stdout: ChildStdout,
        client: Arc<ClaudeAgentClient>,
        cancel: CancellationToken,
        mode: ProtocolMode,
    ) -> Self {
        let peer = Self {
            stdin: Arc::new(Mutex::new(stdin)),
            mode,
        };

        let reader_peer = peer.clone();
        tokio::spawn(async move {
            if let Err(e) = reader_peer.read_loop(stdout, client, cancel).await {
                tracing::error!("Protocol reader loop error: {}", e);
            }
        });

        peer
    }

    async fn read_loop(
        &self,
        stdout: ChildStdout,
        client: Arc<ClaudeAgentClient>,
        cancel: CancellationToken,
    ) -> Result<(), ExecutorError> {
        let mut reader = BufReader::new(stdout);
        let mut buffer = String::new();
        let mut interrupt_sent = false;

        loop {
            buffer.clear();
            tokio::select! {
                biased;
                _ = cancel.cancelled(), if !interrupt_sent => {
                    interrupt_sent = true;
                    tracing::info!("Cancellation received in read_loop, sending interrupt to Claude");
                    if let Err(e) = self.interrupt().await {
                        tracing::warn!("Failed to send interrupt to Claude: {e}");
                    }
                }
                line_result = reader.read_line(&mut buffer) => {
                    match line_result {
                        Ok(0) => break,
                        Ok(_) => {
                            let line = buffer.trim();
                            if line.is_empty() {
                                continue;
                            }
                            client.log_message(line).await?;

                            match serde_json::from_str::<CLIMessage>(line) {
                                Ok(CLIMessage::ControlRequest {
                                    request_id,
                                    request,
                                }) => {
                                    self.handle_control_request(&client, request_id, request)
                                        .await;
                                }
                                Ok(CLIMessage::Result(_)) => {
                                    break;
                                }
                                _ => {}
                            }
                        }
                        Err(e) => {
                            tracing::error!("Error reading stdout: {}", e);
                            break;
                        }
                    }
                }
            }
        }
        Ok(())
    }

    async fn handle_control_request(
        &self,
        client: &Arc<ClaudeAgentClient>,
        request_id: String,
        request: ControlRequestType,
    ) {
        match request {
            ControlRequestType::CanUseTool {
                tool_name,
                input,
                permission_suggestions,
                blocked_paths: _,
                tool_use_id,
            } => {
                match client
                    .on_can_use_tool(tool_name, input, permission_suggestions, tool_use_id)
                    .await
                {
                    Ok(result) => {
                        let value = serde_json::to_value(result).unwrap();
                        if let Err(e) = self.send_response(request_id, value).await {
                            tracing::error!("Failed to send permission result: {e}");
                        }
                    }
                    Err(ExecutorError::ExecutorApprovalError(
                        ExecutorApprovalError::Cancelled,
                    )) => {}
                    Err(e) => {
                        tracing::error!("Error in on_can_use_tool: {e}");
                        if let Err(e2) = self.send_error(request_id, e.to_string()).await {
                            tracing::error!("Failed to send error response: {e2}");
                        }
                    }
                }
            }
            ControlRequestType::HookCallback {
                callback_id,
                input,
                tool_use_id,
            } => {
                match client
                    .on_hook_callback(callback_id, input, tool_use_id)
                    .await
                {
                    Ok(hook_output) => {
                        if let Err(e) = self.send_hook_response(request_id, hook_output).await {
                            tracing::error!("Failed to send hook callback result: {e}");
                        }
                    }
                    Err(e) => {
                        tracing::error!("Error in on_hook_callback: {e}");
                        if let Err(e2) = self.send_error(request_id, e.to_string()).await {
                            tracing::error!("Failed to send error response: {e2}");
                        }
                    }
                }
            }
            ControlRequestType::AskUserQuestion { input, tool_use_id } => {
                match client
                    .on_ask_user_question(request_id.clone(), input, tool_use_id)
                    .await
                {
                    Ok(answers) => {
                        if let Err(e) =
                            self.send_ask_user_question_response(request_id, answers).await
                        {
                            tracing::error!("Failed to send ask_user_question response: {e}");
                        }
                    }
                    Err(ExecutorError::ExecutorApprovalError(
                        ExecutorApprovalError::Cancelled,
                    )) => {}
                    Err(e) => {
                        tracing::error!("Error in on_ask_user_question: {e}");
                        if let Err(e2) = self.send_error(request_id, e.to_string()).await {
                            tracing::error!("Failed to send error response: {e2}");
                        }
                    }
                }
            }
        }
    }

    async fn send_response(
        &self,
        request_id: String,
        result: serde_json::Value,
    ) -> Result<(), ExecutorError> {
        match self.mode {
            ProtocolMode::Bridge => {
                self.send_json(&BridgeCommand::PermissionResponse { request_id, result })
                    .await
            }
            ProtocolMode::Cli => {
                self.send_json(&ControlResponseMessage::new(ControlResponseType::Success {
                    request_id,
                    response: Some(result),
                }))
                .await
            }
        }
    }

    pub async fn send_hook_response(
        &self,
        request_id: String,
        hook_output: serde_json::Value,
    ) -> Result<(), ExecutorError> {
        match self.mode {
            ProtocolMode::Bridge => {
                self.send_json(&BridgeCommand::HookResponse {
                    request_id,
                    output: hook_output,
                })
                .await
            }
            ProtocolMode::Cli => {
                self.send_json(&ControlResponseMessage::new(ControlResponseType::Success {
                    request_id,
                    response: Some(hook_output),
                }))
                .await
            }
        }
    }

    pub async fn send_ask_user_question_response(
        &self,
        request_id: String,
        answers: serde_json::Value,
    ) -> Result<(), ExecutorError> {
        match self.mode {
            ProtocolMode::Bridge => {
                self.send_json(&BridgeCommand::AskUserQuestionResponse {
                    request_id,
                    answers,
                })
                .await
            }
            ProtocolMode::Cli => {
                self.send_json(&ControlResponseMessage::new(ControlResponseType::Success {
                    request_id,
                    response: Some(answers),
                }))
                .await
            }
        }
    }

    async fn send_error(&self, request_id: String, error: String) -> Result<(), ExecutorError> {
        match self.mode {
            ProtocolMode::Bridge => {
                self.send_json(&BridgeCommand::HookResponse {
                    request_id,
                    output: serde_json::json!({ "error": error }),
                })
                .await
            }
            ProtocolMode::Cli => {
                self.send_json(&ControlResponseMessage::new(ControlResponseType::Error {
                    request_id,
                    error: Some(error),
                }))
                .await
            }
        }
    }

    async fn send_json<T: serde::Serialize>(&self, message: &T) -> Result<(), ExecutorError> {
        let json = serde_json::to_string(message)?;
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(json.as_bytes()).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await?;
        Ok(())
    }

    pub async fn initialize_bridge(&self, config: BridgeConfig) -> Result<(), ExecutorError> {
        self.send_json(&BridgeCommand::Init { config }).await
    }

    pub async fn initialize_legacy(
        &self,
        hooks: Option<serde_json::Value>,
    ) -> Result<(), ExecutorError> {
        self.send_json(&SDKControlRequest::new(SDKControlRequestType::Initialize {
            hooks,
        }))
        .await
    }

    pub async fn send_user_message(&self, content: String) -> Result<(), ExecutorError> {
        self.send_json(&Message::new_user(content)).await
    }

    pub async fn interrupt(&self) -> Result<(), ExecutorError> {
        match self.mode {
            ProtocolMode::Bridge => self.send_json(&BridgeCommand::Interrupt {}).await,
            ProtocolMode::Cli => {
                self.send_json(&SDKControlRequest::new(SDKControlRequestType::Interrupt {}))
                    .await
            }
        }
    }

    pub async fn set_permission_mode(&self, mode: PermissionMode) -> Result<(), ExecutorError> {
        match self.mode {
            ProtocolMode::Bridge => {
                self.send_json(&BridgeCommand::SetPermissionMode { mode })
                    .await
            }
            ProtocolMode::Cli => {
                self.send_json(&SDKControlRequest::new(
                    SDKControlRequestType::SetPermissionMode { mode },
                ))
                .await
            }
        }
    }

    pub async fn set_max_thinking_tokens(
        &self,
        max_thinking_tokens: u32,
    ) -> Result<(), ExecutorError> {
        match self.mode {
            ProtocolMode::Bridge => {
                self.send_json(&BridgeCommand::SetMaxThinkingTokens { max_thinking_tokens })
                    .await
            }
            ProtocolMode::Cli => {
                self.send_json(&SDKControlRequest::new(
                    SDKControlRequestType::SetMaxThinkingTokens {
                        max_thinking_tokens,
                    },
                ))
                .await
            }
        }
    }
}
