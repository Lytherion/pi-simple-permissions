import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  createBashTool,
  createLocalBashOperations,
  type BashOperations,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type PermissionMode = "default" | "auto" | "yolo";

interface BashParams {
  command: string;
  timeout?: number;
  sandbox_permissions?: "require_escalated";
  escalation_reason?: string;
}

interface PermissionState {
  mode?: PermissionMode;
}

const MODE_LABELS: Record<PermissionMode, string> = {
  default: "Default",
  auto: "Auto",
  yolo: "YOLO",
};

const READ_ONLY_GIT = new Set([
  "--version",
  "diff",
  "grep",
  "help",
  "log",
  "ls-files",
  "rev-parse",
  "show",
  "status",
  "version",
]);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function canonicalPath(input: string, cwd: string): string {
  const value = input.startsWith("@") ? input.slice(1) : input;
  const expanded = value === "~" || value.startsWith("~/")
    ? resolve(homedir(), value.slice(2))
    : value;
  const target = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);

  let current = target;
  const missing: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(basename(current));
    current = parent;
  }

  const base = existsSync(current) ? realpathSync(current) : current;
  return resolve(base, ...missing);
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function isAutoWritePath(path: string, cwd: string): boolean {
  const target = canonicalPath(path, cwd);
  const project = canonicalPath(cwd, cwd);
  const temp = canonicalPath(tmpdir(), cwd);
  return isWithin(project, target) || isWithin(temp, target);
}

function gitSubcommands(command: string): string[] {
  const matches = command.matchAll(/\bgit(?:\s+(?:-[Cc])\s+\S+|\s+-c\s+\S+)*\s+([^\s;&|]+)/gi);
  return [...matches].map((match) => match[1].toLowerCase());
}

function mutatesGit(command: string): boolean {
  return gitSubcommands(command).some((subcommand) => !READ_ONLY_GIT.has(subcommand));
}

function sandboxCommand(command: string, cwd: string): string {
  const project = canonicalPath(cwd, cwd);
  const temp = canonicalPath(tmpdir(), cwd);
  const writable = [...new Set([project, temp])];
  const args = [
    "bwrap",
    "--die-with-parent",
    "--unshare-all",
    "--share-net",
    "--new-session",
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--chdir", cwd,
  ];

  for (const root of writable) {
    args.push("--bind", root, root);
  }
  args.push("--", "sh", "-lc", command);
  return args.map(shellQuote).join(" ");
}

function createSandboxOperations(): BashOperations {
  const local = createLocalBashOperations();
  return {
    exec(command, cwd, options) {
      return local.exec(sandboxCommand(command, cwd), cwd, options);
    },
  };
}

async function approve(
  ctx: ExtensionContext,
  title: string,
  detail: string,
): Promise<boolean> {
  if (!ctx.hasUI) return false;
  const choice = await ctx.ui.select(`${title}\n\n${detail}`, ["Allow once", "Deny"]);
  return choice === "Allow once";
}

export default function simplePermissions(pi: ExtensionAPI): void {
  let mode: PermissionMode = "default";

  function updateStatus(ctx: ExtensionContext): void {
    let color: "accent" | "muted" | "warning" = "muted";
    if (mode === "auto") color = "accent";
    if (mode === "yolo") color = "warning";

    ctx.ui.setStatus(
      "simple-permissions",
      ctx.ui.theme.fg(color, `Permission: ${MODE_LABELS[mode]}`),
    );
  }

  function setMode(next: PermissionMode, ctx: ExtensionContext): void {
    mode = next;
    pi.appendEntry("simple-permissions", { mode });
    updateStatus(ctx);
    ctx.ui.notify(`Permission mode: ${MODE_LABELS[mode]}`, mode === "yolo" ? "warning" : "info");
  }

  async function chooseMode(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) return;
    const choice = await ctx.ui.select("Permission mode", ["Default", "Auto", "YOLO"]);
    if (choice) setMode(choice.toLowerCase() as PermissionMode, ctx);
  }

  pi.registerCommand("permission", {
    description: "Show or switch permission mode: /permission [default|auto|yolo]",
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      if (!value) {
        await chooseMode(ctx);
        return;
      }
      if (value !== "default" && value !== "auto" && value !== "yolo") {
        ctx.ui.notify("Usage: /permission [default|auto|yolo]", "warning");
        return;
      }
      setMode(value as PermissionMode, ctx);
    },
  });

  pi.registerShortcut("alt+m", {
    description: "Cycle Permission mode (Default -> Auto -> YOLO)",
    handler: async (ctx) => {
      const nextMap: Record<PermissionMode, PermissionMode> = {
        default: "auto",
        auto: "yolo",
        yolo: "default",
      };
      setMode(nextMap[mode], ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const entry = ctx.sessionManager.getEntries()
      .filter((item) => item.type === "custom" && item.customType === "simple-permissions")
      .pop() as { data?: PermissionState } | undefined;
    const savedMode = entry?.data?.mode;
    mode = (savedMode === "auto" || savedMode === "yolo") ? savedMode : "default";
    updateStatus(ctx);
  });

  pi.on("before_agent_start", (event) => {
    let boundaryText = "";
    if (mode === "yolo") {
      boundaryText = "\n\n## Permission boundary\n\nThe active permission mode is YOLO. There are no restrictions. You have full system access without manual approval.";
    } else {
      boundaryText = `\n\n## Permission boundary\n\nThe active permission mode is ${MODE_LABELS[mode]}. Network access and network-search tools are allowed in every mode. In Auto mode, bash is sandboxed so only the current working directory and /tmp are writable. For a necessary write outside those roots, call bash with sandbox_permissions=\"require_escalated\" and a concise escalation_reason. Mutating Git commands always require user approval; read-only Git inspection does not.`;
    }
    return { systemPrompt: `${event.systemPrompt}${boundaryText}` };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (mode === "yolo") return;
    if (event.toolName !== "write" && event.toolName !== "edit") return;

    const path = String(event.input.path ?? "");
    const needsApproval = mode === "default" || !isAutoWritePath(path, ctx.cwd);
    if (!needsApproval) return;

    const allowed = await approve(
      ctx,
      `${MODE_LABELS[mode]} permission request`,
      `${event.toolName}: ${path}`,
    );
    if (!allowed) {
      return {
        block: true,
        reason: ctx.hasUI ? "Blocked by user" : "Permission required, but no interactive UI is available",
      };
    }
  });

  const template = createBashTool(process.cwd());
  const bashParameters = Type.Object({
    command: Type.String({ description: "Bash command to execute" }),
    timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
    sandbox_permissions: Type.Optional(StringEnum(["require_escalated"] as const, {
      description: "Request execution outside the Auto filesystem sandbox",
    })),
    escalation_reason: Type.Optional(Type.String({
      maxLength: 100,
      description: "Concise reason why execution outside the filesystem sandbox is required",
    })),
  });

  pi.registerTool({
    ...template,
    name: "bash",
    label: "bash (permissioned)",
    parameters: bashParameters,
    description: `${template.description}\n\nIn Auto mode, bash can write only inside the current working directory and /tmp. Use sandbox_permissions=\"require_escalated\" only when a necessary operation must write elsewhere. Network access is unrestricted. Mutating Git commands require approval.`,
    async execute(toolCallId, params: BashParams, signal, onUpdate, ctx) {
      const command = params.command.trim();
      const escalated = params.sandbox_permissions === "require_escalated";
      const gitMutation = mutatesGit(command);
      
      const isYolo = mode === "yolo";
      const needsApproval = !isYolo && (mode === "default" || escalated || gitMutation);

      if (needsApproval) {
        const reasons = [
          mode === "default" ? "Default mode" : undefined,
          escalated ? `filesystem escalation${params.escalation_reason ? `: ${params.escalation_reason}` : ""}` : undefined,
          gitMutation ? "mutating Git command" : undefined,
        ].filter(Boolean).join("; ");
        const allowed = await approve(ctx, `${MODE_LABELS[mode]} bash permission request`, `${command}\n\nReason: ${reasons}`);
        if (!allowed) {
          return {
            content: [{
              type: "text",
              text: ctx.hasUI ? "Permission denied by user" : "Permission required, but no interactive UI is available",
            }],
            details: undefined,
          };
        }
      }

      const useSandbox = mode === "auto" && !escalated && !isYolo;
      const tool = useSandbox
        ? createBashTool(ctx.cwd, { operations: createSandboxOperations() })
        : createBashTool(ctx.cwd);
      return tool.execute(
        toolCallId,
        { command, timeout: params.timeout },
        signal,
        onUpdate,
      );
    },
  });
}
