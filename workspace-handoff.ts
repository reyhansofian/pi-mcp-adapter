import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { McpConfig, MetadataCache, ServerEntry } from "./types.ts";

const NAMESPACE = "pi-mcp-adapter/1";
const TOOLS = ["read_file", "list_dir", "find_file", "search_for_pattern", "get_symbols_overview", "find_symbol", "find_referencing_symbols", "get_incoming_calls", "get_outgoing_calls"];
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const stable = (value: unknown): string => {
  if (value === null || value === undefined || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
};

function serverHash(definition: ServerEntry): string {
  const identity = { command: definition.command, args: definition.args, socket: definition.socket, env: definition.env, cwd: definition.cwd,
    url: definition.url, headers: definition.headers, requestHeadersCommand: definition.requestHeadersCommand, auth: definition.auth,
    protocolVersion: definition.protocolVersion, bearerToken: definition.bearerToken, bearerTokenEnv: definition.bearerTokenEnv,
    exposeResources: definition.exposeResources, includeTools: definition.includeTools, excludeTools: definition.excludeTools };
  return createHash("sha256").update(stable(identity)).digest("hex");
}

function exact(value: Record<string, unknown>, keys: string[], label: string) {
  if (Object.keys(value).sort().join(",") !== keys.sort().join(",")) throw new Error(`${label} has unexpected fields`);
}

export function loadWorkspaceHandoff(raw: string | undefined, cwd = process.cwd()): { config: McpConfig; cache: MetadataCache; assertValid: () => void } | undefined {
  if (!raw) return undefined;
  let bindings: unknown;
  try { bindings = JSON.parse(raw); } catch { throw new Error("PI_SUBAGENT_EXTENSION_BINDINGS is not JSON"); }
  if (!record(bindings) || bindings[NAMESPACE] === undefined) return undefined;
  const binding = bindings[NAMESPACE];
  if (!record(binding)) throw new Error("MCP workspace handoff binding is invalid");
  exact(binding, ["path", "sha256"], "MCP workspace handoff binding");
  if (typeof binding.path !== "string" || !isAbsolute(binding.path) || typeof binding.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(binding.sha256)) throw new Error("MCP workspace handoff binding is invalid");
  const workspace = realpathSync(cwd);
  if (process.getuid && lstatSync(workspace).uid !== process.getuid()) throw new Error("MCP workspace handoff cwd is not owned by this user");
  const expected = join(workspace, ".pi", "mcp-handoffs", "serena.json");
  if (resolve(cwd) !== workspace || binding.path !== expected) throw new Error("MCP workspace handoff path does not match cwd");
  let current = binding.path;
  while (current !== workspace) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (current === binding.path ? !stat.isFile() : !stat.isDirectory()) || (process.getuid && stat.uid !== process.getuid())) throw new Error("MCP workspace handoff path is unsafe");
    current = dirname(current);
    if (!current.startsWith(`${workspace}${sep}`) && current !== workspace) throw new Error("MCP workspace handoff path escapes cwd");
  }
  const bytes = readFileSync(binding.path);
  if (createHash("sha256").update(bytes).digest("hex") !== binding.sha256) throw new Error("MCP workspace handoff digest mismatch");
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("MCP workspace handoff receipt is not JSON"); }
  if (!record(parsed)) throw new Error("MCP workspace handoff receipt is invalid");
  exact(parsed, ["version", "workspace", "leaseId", "bootId", "observedAtMs", "definition", "tools"], "MCP workspace handoff receipt");
  if (parsed.version !== 1 || parsed.workspace !== workspace || typeof parsed.leaseId !== "string" || !/^[0-9a-f]{64}$/.test(parsed.leaseId)
    || parsed.bootId !== readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || !Number.isSafeInteger(parsed.observedAtMs)) throw new Error("MCP workspace handoff identity is invalid");
  if (!record(parsed.definition)) throw new Error("MCP workspace handoff definition is invalid");
  const definition = parsed.definition;
  exact(definition, ["url", "includeTools", "exposeResources", "lifecycle"], "MCP workspace handoff definition");
  const url = typeof definition.url === "string" ? new URL(definition.url) : undefined;
  if (!url || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/mcp" || url.search || url.hash
    || definition.lifecycle !== "eager" || definition.exposeResources !== false || !Array.isArray(definition.includeTools)
    || definition.includeTools.join("\0") !== TOOLS.join("\0")) throw new Error("MCP workspace handoff definition violates the Serena contract");
  if (!Array.isArray(parsed.tools) || parsed.tools.length !== TOOLS.length) throw new Error("MCP workspace handoff metadata is incomplete");
  const tools = parsed.tools.map(tool => {
    if (!record(tool) || typeof tool.name !== "string" || !record(tool.inputSchema)) throw new Error("MCP workspace handoff metadata is invalid");
    return tool;
  });
  if (tools.map(tool => tool.name).sort().join("\0") !== [...TOOLS].sort().join("\0")) throw new Error("MCP workspace handoff tools do not match the grant");
  const server = definition as ServerEntry;
  return {
    config: { mcpServers: { serena: server } },
    cache: { version: 1, servers: { serena: { configHash: serverHash(server), cachedAt: Date.now(), resources: [], tools: tools.map(tool => ({ name: tool.name as string, description: typeof tool.description === "string" ? tool.description : "", inputSchema: tool.inputSchema })) } } },
    assertValid: () => { loadWorkspaceHandoff(raw, cwd); },
  };
}
