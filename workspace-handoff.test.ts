import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { loadWorkspaceHandoff } from "./workspace-handoff.ts";
import { updateMetadataCache } from "./init.ts";

const tools = ["read_file", "list_dir", "find_file", "search_for_pattern", "get_symbols_overview", "find_symbol", "find_referencing_symbols", "get_incoming_calls", "get_outgoing_calls"];

describe("workspace handoff", () => {
  it("loads definition and metadata together and detects invalidation", () => {
    const cwd = mkdtempSync(join(tmpdir(), "adapter-handoff-"));
    const path = join(cwd, ".pi", "mcp-handoffs", "serena.json");
    mkdirSync(dirname(path), { recursive: true });
    const bytes = JSON.stringify({ version: 1, workspace: cwd, leaseId: "a".repeat(64), bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), observedAtMs: Date.now(), definition: { url: "http://127.0.0.1:32123/mcp", includeTools: tools, exposeResources: false, lifecycle: "eager" }, tools: tools.map(name => ({ name, inputSchema: { type: "object" } })) });
    writeFileSync(path, bytes);
    const binding = JSON.stringify({ "pi-mcp-adapter/1": { path, sha256: createHash("sha256").update(bytes).digest("hex") } });
    try {
      const loaded = loadWorkspaceHandoff(binding, cwd)!;
      assert.deepEqual(Object.keys(loaded.config.mcpServers), ["serena"]);
      assert.deepEqual(loaded.cache.servers.serena!.tools.map(tool => tool.name), tools);
      writeFileSync(path, `${bytes}\n`);
      assert.throws(() => loadWorkspaceHandoff(binding, cwd), /digest mismatch/);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it("refreshes bound metadata in memory without touching the global cache", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "adapter-global-cache-"));
    const cachePath = join(agentDir, "mcp-cache.json");
    const original = '{"version":1,"servers":{"owner":{"tools":[]}}}\n';
    writeFileSync(cachePath, original);
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const metadataCache: any = { version: 1, servers: { serena: { configHash: "old", tools: [], resources: [], cachedAt: 1 } } };
      updateMetadataCache({
        provisionalInstalls: new Set(), metadataCache,
        config: { mcpServers: { serena: { url: "http://127.0.0.1:32123/mcp", exposeResources: false } } },
        manager: { getConnection: () => ({ status: "connected", tools: [{ name: "read_file", inputSchema: { type: "object" } }], resources: [], prompts: [] }) },
      } as any, "serena");
      assert.deepEqual(metadataCache.servers.serena.tools.map((tool: any) => tool.name), ["read_file"]);
      assert.equal(readFileSync(cachePath, "utf8"), original);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
