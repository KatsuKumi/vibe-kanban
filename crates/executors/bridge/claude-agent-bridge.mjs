import { query } from "@anthropic-ai/claude-agent-sdk";
import { createInterface } from "readline";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const pendingRequests = new Map();
let activeQuery = null;

function writeLine(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function buildCanUseTool(stdinRL, needsFullPermissionChecks) {
  return async (toolName, input, { signal, suggestions, toolUseID }) => {
    if (toolName === "AskUserQuestion") {
      return handleAskUserQuestion(input, signal, toolUseID);
    }

    if (!needsFullPermissionChecks) {
      return { behavior: "allow", updatedInput: input };
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
        tool_use_id: toolUseID ?? null,
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

function handleAskUserQuestion(input, signal, toolUseID) {
  const requestId = randomUUID();

  writeLine({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "ask_user_question",
      input,
      tool_use_id: toolUseID ?? null,
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
        parent_tool_use_id: msg.parent_tool_use_id ?? undefined,
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

  let mcpServers;
  try {
    const claudeJsonPath = join(homedir(), ".claude.json");
    const claudeJson = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
    if (claudeJson.mcpServers && Object.keys(claudeJson.mcpServers).length > 0) {
      mcpServers = claudeJson.mcpServers;
    }
  } catch {
    // ~/.claude.json not found or invalid — no MCP servers to load
  }

  const options = {
    cwd: config.cwd,
    permissionMode: config.permission_mode ?? "default",
    includePartialMessages: config.include_partial_messages ?? true,
    disallowedTools: config.disallowed_tools ?? [],
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: [
        "# Tool Usage",
        "",
        "Always prefer dedicated tools over Bash equivalents:",
        "- Search file contents: prefer `Grep` over `grep` or `rg` via Bash",
        "- Find files by pattern: prefer `Glob` over `find` or `ls` via Bash",
        "- Read files: prefer `Read` over `cat`, `head`, or `tail` via Bash",
        "- Edit files: prefer `Edit` or `Write` over `sed`, `awk`, or `echo >` via Bash",
        "",
        "# Workspace Agent Rules",
        "",
        "You are working in a git worktree on a dedicated feature branch. Your current working directory IS your workspace.",
        "- All file paths mentioned in the task description are relative to your cwd. If the task references a file like `C:\\project\\src\\main.cpp` but `src/main.cpp` exists in your cwd, work on the local copy.",
        "- Never checkout, merge into, or commit directly to the main branch. You are on an isolated branch.",
        "- Stay focused on the assigned task. Do not refactor unrelated code, add unrelated features, or make changes outside the task scope.",
        "",
        "# Work Quality",
        "",
        "You are assigned to a single task with dedicated time and context. Use it wisely:",
        "- Read and understand existing code thoroughly before making changes.",
        "- Run tests and verify your changes work before considering the task done.",
        "- When your work is complete, commit all changes with a clear, descriptive commit message. Do not push unless explicitly asked.",
        "",
        "# Project Context (Vibe Kanban MCP)",
        "",
        "You have access to a task management system via the `vibe_kanban` MCP server. Use it freely — you do not need user approval to read project data.",
        "- To browse other tasks in the project: `mcp__vibe_kanban__list_tasks` (requires `project_id`)",
        "- To read a specific task's full context: `mcp__vibe_kanban__get_task` (requires `project_id` and `task_id`)",
        "- To list available projects: `mcp__vibe_kanban__list_projects`",
        "- To update a task: `mcp__vibe_kanban__update_task` (requires `project_id`, `task_id`, and fields to update)",
        "If your task references other tasks, or you need to understand how your work fits into the broader project, read those tasks for context before starting.",
        "",
        "If you discover something outside your task scope that deserves dedicated attention — a bug, a broken dependency, a security concern, or a worthwhile new feature — create a new task for it. All created tasks will be reviewed, so don't hesitate. However, do not create tasks for minor observations, style nitpicks, or things you can trivially fix inline — only for issues or ideas that need their own focused work.",
        "",
        "**When creating tasks, always use the `create-task` skill** (`/create-task`) — it enforces a standardized template (Objective, Acceptance Criteria, Context, Scope, Dependencies, Files, Reproduction Steps) and handles calling `mcp__vibe_kanban__create_task` with the correct format. Never call `mcp__vibe_kanban__create_task` directly with an unstructured description.",
        "",
        "# End of Session (MANDATORY)",
        "",
        "Before finishing, you MUST do the following:",
        "1. Update your current task's description using `mcp__vibe_kanban__update_task`: append a clear and complete summary of what you changed, which files were modified, and any decisions you made. Keep the original description intact and add your summary below it under a `## Changes Made` heading.",
        "2. Include a brief Vibe Kanban activity log in your final message:",
        "   - Tasks read for context (task ID and title).",
        "   - Tasks created (task ID, title, and why).",
        "",
        "# Project Knowledge Maintenance",
        "",
        "You are responsible for keeping shared project knowledge accurate. This is part of completing your task.",
        "",
        "**CLAUDE.md** (repo root): Read it at session start. If you find outdated info, fix it. If you establish new patterns, add key dependencies, or make architectural decisions, document them. Create it if it doesn't exist. Keep it concise — sections and bullets, no walls of text.",
        "",
        "**Memory files**: Check your auto-memory directory for relevant context before starting. Save tricky debugging insights or non-obvious behaviors so future sessions don't repeat the work. Remove entries you confirm are wrong.",
        "",
        "**Skills** (`.claude/skills/<name>/SKILL.md`): If you notice a genuinely repeated workflow pattern, create a skill for it. Each skill is a folder containing a `SKILL.md` file with YAML frontmatter (`name`, `description`, `allowed-tools`) followed by the prompt template. Any agent can invoke skills. Only create skills for workflows that are clearly repeated — not speculatively. Fix broken or outdated skills if you encounter them.",
      ].join("\n"),
    },
    effort: "medium",
    thinking: { type: "adaptive" },
    settingSources: ["user", "project", "local"],
    extraArgs: { "replay-user-messages": null },
  };

  if (mcpServers) {
    options.mcpServers = mcpServers;
  }

  if (config.model) {
    options.model = config.model;
  }

  if (config.thinking) {
    options.thinking = config.thinking;
  }

  if (config.effort) {
    options.effort = config.effort;
  }

  if (config.betas && config.betas.length > 0) {
    options.betas = config.betas;
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

  options.env = { ...process.env, ...(config.env ?? {}) };

  const needsFullPermissionChecks =
    !config.dangerously_skip_permissions &&
    (config.permission_mode === "plan" ||
      config.permission_mode === "default" ||
      config.permission_mode === "acceptEdits");

  options.canUseTool = buildCanUseTool(stdinRL, needsFullPermissionChecks);

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
