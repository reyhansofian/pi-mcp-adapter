import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMcpAdapter } from "../index.ts";
import {
  EXTENSION_BINDING_CONTEXT_KEY,
  readExtensionBindingContextFrom,
  resolveExtensionInitializationInputs,
} from "../extension-binding-context.ts";

const context = (extensionBindingsJson: string | undefined, mcpDirectTools: string | undefined) =>
  Object.freeze({ extensionBindingsJson, mcpDirectTools });

const channel = (getStore: () => unknown) => Object.freeze({ version: 1, run() {}, getStore });

function targetWith(value: unknown): object {
  const target = {};
  Object.defineProperty(target, EXTENSION_BINDING_CONTEXT_KEY, { value, enumerable: false, writable: false, configurable: false });
  return target;
}

describe("request-scoped extension binding context", () => {
  it("selects active explicit values and falls back only when no store is active", () => {
    const env = { PI_SUBAGENT_EXTENSION_BINDINGS: '{"env/1":true}', MCP_DIRECT_TOOLS: "env/tool" };
    expect(resolveExtensionInitializationInputs(targetWith(channel(() => undefined)), env)).toEqual({
      extensionBindingsJson: env.PI_SUBAGENT_EXTENSION_BINDINGS,
      mcpDirectTools: env.MCP_DIRECT_TOOLS,
    });
    expect(resolveExtensionInitializationInputs(targetWith(channel(() => context(undefined, ""))), env)).toEqual({
      extensionBindingsJson: undefined,
      mcpDirectTools: "",
    });
    expect(resolveExtensionInitializationInputs(targetWith(channel(() => context("{}", "__none__"))), env)).toEqual({
      extensionBindingsJson: "{}",
      mcpDirectTools: "__none__",
    });
  });

  it("validates descriptors without invoking accessors or preserving throwing payloads", () => {
    let invoked = false;
    const accessorContext = {};
    Object.defineProperty(accessorContext, "extensionBindingsJson", { enumerable: true, get() { invoked = true; return "secret"; } });
    Object.defineProperty(accessorContext, "mcpDirectTools", { value: undefined, enumerable: true });
    Object.freeze(accessorContext);
    expect(() => readExtensionBindingContextFrom(targetWith(channel(() => accessorContext)))).toThrow("Invalid pi-subagents extension-binding context v1");
    expect(invoked).toBe(false);

    const cause = new Error("secret payload");
    try {
      readExtensionBindingContextFrom(targetWith(channel(() => { throw cause; })));
      throw new Error("expected context failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Invalid pi-subagents extension-binding context v1");
      expect(Object.hasOwn(error as object, "cause")).toBe(false);
      expect((error as Error).message).not.toContain("secret payload");
    }

    const accessorChannel = {};
    Object.defineProperty(accessorChannel, "version", { value: 1, enumerable: true });
    Object.defineProperty(accessorChannel, "run", { enumerable: true, get() { invoked = true; return () => {}; } });
    Object.defineProperty(accessorChannel, "getStore", { value: () => undefined, enumerable: true });
    Object.freeze(accessorChannel);
    expect(() => readExtensionBindingContextFrom(targetWith(accessorChannel))).toThrow("Invalid pi-subagents extension-binding context v1");
    expect(invoked).toBe(false);

    const spoofed = new Proxy({}, { getPrototypeOf() { throw new Error("Invalid pi-subagents extension-binding context v1", { cause: "secret payload" }); } });
    try {
      readExtensionBindingContextFrom(targetWith(spoofed));
      throw new Error("expected context failure");
    } catch (error) {
      expect(Object.hasOwn(error as object, "cause")).toBe(false);
    }
  });

  it("keeps the protocol source free of literal NUL bytes", () => {
    expect(readFileSync(new URL("../extension-binding-context.ts", import.meta.url)).includes(0)).toBe(false);
  });

  it("rejects malformed contextual JSON without exposing payloads", () => {
    for (const raw of ["secret payload", "null", "[]", "1"]) {
      expect(() => resolveExtensionInitializationInputs(targetWith(channel(() => context(raw, undefined))), {})).toThrow("Invalid pi-subagents extension bindings JSON");
      try { resolveExtensionInitializationInputs(targetWith(channel(() => context(raw, undefined))), {}); }
      catch (error) {
        expect((error as Error).message).not.toContain(raw);
        expect(Object.hasOwn(error as object, "cause")).toBe(false);
      }
    }
  });

  it("captures the active context at the adapter factory boundary", () => {
    let store: unknown;
    const existing = Object.getOwnPropertyDescriptor(globalThis, EXTENSION_BINDING_CONTEXT_KEY);
    if (!existing) Object.defineProperty(globalThis, EXTENSION_BINDING_CONTEXT_KEY, {
      value: channel(() => store), enumerable: false, writable: false, configurable: false,
    });
    else if (!("value" in existing) || typeof existing.value?.getStore !== "function") throw new Error("unexpected test context channel");

    store = context("secret payload", "__none__");
    try {
      expect(() => createMcpAdapter()({} as never)).toThrow("Invalid pi-subagents extension bindings JSON");
    } finally {
      store = undefined;
    }
  });
});
