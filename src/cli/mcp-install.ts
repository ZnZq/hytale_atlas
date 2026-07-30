import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Printing the registration for this server, per AI client.
 *
 * It prints and does nothing else. Writing was tried and dropped: there is no
 * universal MCP client config -- five shapes across JSON and TOML, on a field
 * that is a string here and an array there -- and every one of those files is
 * owned by another application. Editing them means a parser per format, a merge
 * that must not disturb comments, and a silent break every time one of thirty-odd
 * clients changes its layout.
 *
 * What a README genuinely cannot do is fill in the absolute paths, which is the
 * step people get wrong. That is the whole job here.
 */

/** The name this server is registered under, in every client. */
const SERVER_NAME = "hytale-atlas";

type Shape = "mcpServers" | "servers" | "contextServers" | "opencode" | "toml";

export interface McpTarget {
  readonly id: string;
  readonly label: string;
  readonly shape: Shape;
  /** The config file for this client, absolute. */
  readonly file: string;
  /** Evidence the client is installed, independent of the file existing. */
  readonly marker: string;
  /** The client's own command, ready to paste, when it has a scriptable one. */
  readonly cli?: string;
}

/**
 * How this server is launched.
 *
 * `process.execPath` and the resolved entry point, both absolute. A client starts
 * the server from its own working directory with its own PATH, so a bare `node`
 * or a relative path is a config that works on the machine that wrote it and
 * nowhere else.
 */
export function launchCommand(): { command: string; args: readonly string[] } {
  const entry = fileURLToPath(new URL("./main.js", import.meta.url));
  return { command: process.execPath, args: [entry, "--mcp"] };
}

/** Quotes only when a shell would otherwise split it. */
function q(value: string): string {
  return /^[A-Za-z0-9._:/\\-]+$/.test(value) ? value : `"${value}"`;
}

/**
 * Where VS Code keeps extension state, which is where Cline and Roo Code put
 * their MCP settings.
 *
 * Their own docs list macOS and Linux only; the Windows path follows VS Code's
 * documented APPDATA convention and has not been confirmed against a real
 * install here.
 */
function vscodeGlobalStorage(home: string): string {
  if (platform() === "win32") {
    const roaming = process.env["APPDATA"] ?? join(home, "AppData", "Roaming");
    return join(roaming, "Code", "User", "globalStorage");
  }
  if (platform() === "darwin") {
    return join(home, "Library", "Application Support", "Code", "User", "globalStorage");
  }
  return join(home, ".config", "Code", "User", "globalStorage");
}

export function targets(cwd: string = process.cwd(), home: string = homedir()): McpTarget[] {
  const { command, args } = launchCommand();
  const line = [command, ...args].map(q).join(" ");
  const gs = vscodeGlobalStorage(home);

  return [
    {
      id: "claude-code",
      label: "Claude Code -- project (shareable via git)",
      shape: "mcpServers",
      file: join(cwd, ".mcp.json"),
      marker: join(home, ".claude.json"),
      // The `--` is not optional: our own arguments contain `--mcp`, and without
      // the separator the client reads that as one of its own flags.
      cli: `claude mcp add ${SERVER_NAME} --scope project -- ${line}`,
    },
    {
      id: "claude-code-user",
      label: "Claude Code -- user (every project)",
      shape: "mcpServers",
      file: join(home, ".claude.json"),
      marker: join(home, ".claude.json"),
      cli: `claude mcp add ${SERVER_NAME} --scope user -- ${line}`,
    },
    {
      id: "cursor",
      label: "Cursor",
      shape: "mcpServers",
      file: join(home, ".cursor", "mcp.json"),
      marker: join(home, ".cursor"),
    },
    {
      id: "windsurf",
      label: "Windsurf",
      shape: "mcpServers",
      file: join(home, ".codeium", "windsurf", "mcp_config.json"),
      marker: join(home, ".codeium", "windsurf"),
    },
    {
      id: "vscode",
      label: "VS Code / GitHub Copilot -- workspace",
      shape: "servers",
      file: join(cwd, ".vscode", "mcp.json"),
      marker: join(cwd, ".vscode"),
      cli: `code --add-mcp ${JSON.stringify(
        JSON.stringify({ name: SERVER_NAME, command, args: [...args] }),
      )}`,
    },
    {
      id: "gemini-cli",
      label: "Gemini CLI",
      shape: "mcpServers",
      file: join(home, ".gemini", "settings.json"),
      marker: join(home, ".gemini"),
      cli: `gemini mcp add ${SERVER_NAME} -s user ${line}`,
    },
    {
      id: "codex",
      label: "Codex",
      shape: "toml",
      file: join(home, ".codex", "config.toml"),
      marker: join(home, ".codex"),
    },
    {
      id: "zed",
      label: "Zed",
      shape: "contextServers",
      file: join(home, ".config", "zed", "settings.json"),
      marker: join(home, ".config", "zed"),
    },
    {
      // No flags at all -- `opencode mcp add` prompts, so it cannot be pasted.
      id: "opencode",
      label: "opencode -- project",
      shape: "opencode",
      file: join(cwd, "opencode.json"),
      marker: join(cwd, "opencode.json"),
    },
    {
      id: "cline",
      label: "Cline (VS Code extension)",
      shape: "mcpServers",
      file: join(gs, "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
      marker: join(gs, "saoudrizwan.claude-dev"),
    },
    {
      id: "roo-code",
      label: "Roo Code (VS Code extension)",
      shape: "mcpServers",
      file: join(gs, "rooveterinaryinc.roo-cline", "settings", "mcp_settings.json"),
      marker: join(gs, "rooveterinaryinc.roo-cline"),
    },
  ];
}

/** True when this client looks installed, or is already configured here. */
export function detected(t: McpTarget): boolean {
  return existsSync(t.marker) || existsSync(t.file);
}

/**
 * The entry to paste, in that client's own shape.
 *
 * Five shapes, and the differences bite: opencode takes ONE array rather than a
 * command plus arguments, Zed calls the key `context_servers`, and Codex is not
 * JSON at all.
 */
export function snippet(t: McpTarget): string {
  const { command, args } = launchCommand();

  if (t.shape === "toml") {
    return (
      `[mcp_servers.${SERVER_NAME}]\n` +
      `command = ${JSON.stringify(command)}\n` +
      `args = [${args.map((a) => JSON.stringify(a)).join(", ")}]\n`
    );
  }

  const entry =
    t.shape === "opencode"
      ? { type: "local", command: [command, ...args], enabled: true }
      : { command, args: [...args] };

  const key =
    t.shape === "opencode" ? "mcp" : t.shape === "contextServers" ? "context_servers" : t.shape;

  const body: Record<string, unknown> = { [key]: { [SERVER_NAME]: entry } };
  if (t.shape === "opencode") body["$schema"] = "https://opencode.ai/config.json";
  return `${JSON.stringify(body, null, 2)}\n`;
}
