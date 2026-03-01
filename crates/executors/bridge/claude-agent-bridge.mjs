import { query } from "@anthropic-ai/claude-agent-sdk";
import { createInterface } from "readline";
import { randomUUID } from "crypto";

const pendingRequests = new Map();
let activeQuery = null;

function writeLine(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function buildCanUseTool(stdinRL) {
  return async (toolName, input, { signal, suggestions }) => {
    if (toolName === "AskUserQuestion") {
      return handleAskUserQuestion(input, signal);
    }

    const requestId = randomUUID();

    writeLine({
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "can_use_tool",
        tool_name: toolName,
        input,
        permission_suggestions: suggestions ?? null,
        tool_use_id: null,
      },
    });

    return new Promise((resolve, reject) => {
      pendingRequests.set(requestId, { resolve, reject });
      signal?.addEventListener("abort", () => {
        pendingRequests.delete(requestId);
        reject(new Error("Aborted"));
      });
    });
  };
}

function handleAskUserQuestion(input, signal) {
  const requestId = randomUUID();

  writeLine({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "ask_user_question",
      input,
      tool_use_id: null,
    },
  });

  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, {
      resolve: (answers) => {
        resolve({
          behavior: "allow",
          updatedInput: {
            ...input,
            answers,
          },
        });
      },
      reject,
    });
    signal?.addEventListener("abort", () => {
      pendingRequests.delete(requestId);
      reject(new Error("Aborted"));
    });
  });
}

function buildHookCallback(callbackId) {
  return async (inputData, toolUseId) => {
    const requestId = randomUUID();

    writeLine({
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "hook_callback",
        callback_id: callbackId,
        input: inputData ?? {},
        tool_use_id: toolUseId ?? null,
      },
    });

    return new Promise((resolve, reject) => {
      pendingRequests.set(requestId, { resolve, reject });
    });
  };
}

function translateHooks(hooksJson) {
  if (!hooksJson || typeof hooksJson !== "object") return undefined;

  const sdkHooks = {};

  for (const [eventName, matchers] of Object.entries(hooksJson)) {
    if (!Array.isArray(matchers)) continue;

    sdkHooks[eventName] = matchers.map((m) => {
      const hooks = (m.hookCallbackIds || []).map((cbId) =>
        buildHookCallback(cbId)
      );
      return {
        matcher: m.matcher ?? undefined,
        hooks,
      };
    });
  }

  return sdkHooks;
}

function translateMessage(msg) {
  switch (msg.type) {
    case "system":
      writeLine(msg);
      break;

    case "assistant":
      writeLine({
        type: "assistant",
        message: msg.message,
        session_id: msg.session_id,
        uuid: msg.uuid,
        parent_tool_use_id: msg.parent_tool_use_id ?? undefined,
      });
      break;

    case "user":
      writeLine(msg);
      break;

    case "result":
      writeLine({
        type: "result",
        subtype: msg.subtype ?? "success",
        is_error: msg.subtype?.startsWith("error") ?? false,
        duration_ms: msg.duration_ms,
        duration_api_ms: msg.duration_api_ms,
        result: msg.result,
        session_id: msg.session_id,
        total_cost_usd: msg.total_cost_usd,
        usage: msg.usage,
        model_usage: msg.modelUsage,
        num_turns: msg.num_turns,
      });
      break;

    case "stream_event":
      writeLine({
        type: "stream_event",
        event: msg.event,
        session_id: msg.session_id,
        uuid: msg.uuid,
      });
      break;

    default:
      writeLine(msg);
      break;
  }
}

function handleStdinCommand(line) {
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    return;
  }

  switch (cmd.type) {
    case "interrupt":
      if (activeQuery) {
        activeQuery.interrupt().catch((e) => {
          process.stderr.write(`Interrupt error: ${e.message}\n`);
        });
      }
      break;

    case "set_permission_mode":
      if (activeQuery) {
        activeQuery.setPermissionMode(cmd.mode).catch((e) => {
          process.stderr.write(`SetPermissionMode error: ${e.message}\n`);
        });
      }
      break;

    case "set_max_thinking_tokens":
      if (activeQuery) {
        activeQuery
          .setMaxThinkingTokens(cmd.max_thinking_tokens)
          .catch((e) => {
            process.stderr.write(
              `SetMaxThinkingTokens error: ${e.message}\n`
            );
          });
      }
      break;

    case "permission_response": {
      const pending = pendingRequests.get(cmd.request_id);
      if (pending) {
        pendingRequests.delete(cmd.request_id);
        pending.resolve(cmd.result);
      }
      break;
    }

    case "hook_response": {
      const pending = pendingRequests.get(cmd.request_id);
      if (pending) {
        pendingRequests.delete(cmd.request_id);
        pending.resolve(cmd.output);
      }
      break;
    }

    case "ask_user_question_response": {
      const pending = pendingRequests.get(cmd.request_id);
      if (pending) {
        pendingRequests.delete(cmd.request_id);
        pending.resolve(cmd.answers);
      }
      break;
    }
  }
}

async function main() {
  const stdinRL = createInterface({ input: process.stdin });

  const initLine = await new Promise((resolve) => {
    stdinRL.once("line", resolve);
  });

  let initCmd;
  try {
    initCmd = JSON.parse(initLine);
  } catch (e) {
    process.stderr.write(`Failed to parse init command: ${e.message}\n`);
    process.exit(1);
  }

  if (initCmd.type !== "init") {
    process.stderr.write(
      `Expected init command, got: ${initCmd.type}\n`
    );
    process.exit(1);
  }

  const config = initCmd.config;

  stdinRL.on("line", handleStdinCommand);

  const options = {
    cwd: config.cwd,
    permissionMode: config.permission_mode ?? "default",
    includePartialMessages: config.include_partial_messages ?? true,
    disallowedTools: config.disallowed_tools ?? [],
    settingSources: ["user", "project", "local"],
    extraArgs: { "replay-user-messages": null },
  };

  if (config.model) {
    options.model = config.model;
  }

  if (config.max_thinking_tokens != null) {
    options.maxThinkingTokens = config.max_thinking_tokens;
  }

  if (config.dangerously_skip_permissions) {
    options.permissionMode = "bypassPermissions";
    options.allowDangerouslySkipPermissions = true;
  }

  if (config.resume) {
    options.resume = config.resume;
  }

  if (config.resume_at) {
    options.resumeSessionAt = config.resume_at;
  }

  if (config.path_to_claude_code_executable) {
    options.pathToClaudeCodeExecutable = config.path_to_claude_code_executable;
  }

  if (config.env && Object.keys(config.env).length > 0) {
    options.env = { ...process.env, ...config.env };
  }

  const needsCanUseTool =
    config.permission_mode === "plan" ||
    config.permission_mode === "default" ||
    config.permission_mode === "acceptEdits";

  if (needsCanUseTool && !config.dangerously_skip_permissions) {
    options.canUseTool = buildCanUseTool(stdinRL);
  }

  const translatedHooks = translateHooks(config.hooks);
  if (translatedHooks) {
    options.hooks = translatedHooks;
  }

  options.stderr = (data) => {
    process.stderr.write(data);
  };

  try {
    activeQuery = query({ prompt: config.prompt, options });

    for await (const message of activeQuery) {
      translateMessage(message);
    }
  } catch (e) {
    writeLine({
      type: "result",
      subtype: "error_tool_use",
      is_error: true,
      result: e.message,
      session_id: null,
      duration_ms: 0,
    });
  } finally {
    stdinRL.close();
    process.exit(0);
  }
}

main();
