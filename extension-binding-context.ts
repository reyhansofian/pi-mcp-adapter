export const EXTENSION_BINDING_CONTEXT_KEY = Symbol.for("pi-subagents.extension-binding-context.v1");

const INVALID_CONTEXT = "Invalid pi-subagents extension-binding context v1";
const INVALID_BINDINGS_JSON = "Invalid pi-subagents extension bindings JSON";
const CHANNEL_KEYS = ["getStore", "run", "version"];
const CONTEXT_KEYS = ["extensionBindingsJson", "mcpDirectTools"];

interface ExtensionBindingContext {
  readonly extensionBindingsJson: string | undefined;
  readonly mcpDirectTools: string | undefined;
}

interface ContextRead {
  active: boolean;
  extensionBindingsJson?: string;
  mcpDirectTools?: string;
}

function invalidContext(): Error {
  return new Error(INVALID_CONTEXT);
}

function exactFrozenDataObject(value: unknown, keys: string[]): Record<string, unknown> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidContext();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw invalidContext();
    if (!Object.isFrozen(value) || Object.getOwnPropertySymbols(value).length > 0) throw invalidContext();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(descriptors).sort().join("\0") !== keys.join("\0")) throw invalidContext();
    for (const key of keys) {
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable || !("value" in descriptor)) throw invalidContext();
    }
    return value as Record<string, unknown>;
  } catch {
    throw invalidContext();
  }
}

export function readExtensionBindingContextFrom(target: object): ContextRead {
  let descriptor: PropertyDescriptor | undefined;
  try { descriptor = Object.getOwnPropertyDescriptor(target, EXTENSION_BINDING_CONTEXT_KEY); }
  catch { throw invalidContext(); }
  if (!descriptor) return { active: false };
  if (descriptor.enumerable || descriptor.configurable || !("value" in descriptor) || descriptor.writable) throw invalidContext();
  const channel = exactFrozenDataObject(descriptor.value, CHANNEL_KEYS);
  if (channel.version !== 1 || typeof channel.run !== "function" || typeof channel.getStore !== "function") throw invalidContext();
  let store: unknown;
  try { store = (channel.getStore as () => unknown)(); }
  catch { throw invalidContext(); }
  if (store === undefined) return { active: false };
  const context = exactFrozenDataObject(store, CONTEXT_KEYS);
  if ((context.extensionBindingsJson !== undefined && typeof context.extensionBindingsJson !== "string")
    || (context.mcpDirectTools !== undefined && typeof context.mcpDirectTools !== "string")) throw invalidContext();
  return {
    active: true,
    ...(context.extensionBindingsJson !== undefined ? { extensionBindingsJson: context.extensionBindingsJson } : {}),
    ...(context.mcpDirectTools !== undefined ? { mcpDirectTools: context.mcpDirectTools } : {}),
  };
}

function validateContextualBindingsJson(raw: string | undefined): void {
  if (raw === undefined) return;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(INVALID_BINDINGS_JSON); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(INVALID_BINDINGS_JSON);
}

export function resolveExtensionInitializationInputs(
  target: object = globalThis,
  env: Record<string, string | undefined> = process.env,
): { extensionBindingsJson: string | undefined; mcpDirectTools: string | undefined } {
  const context = readExtensionBindingContextFrom(target);
  if (!context.active) return {
    extensionBindingsJson: env.PI_SUBAGENT_EXTENSION_BINDINGS,
    mcpDirectTools: env.MCP_DIRECT_TOOLS,
  };
  validateContextualBindingsJson(context.extensionBindingsJson);
  return {
    extensionBindingsJson: context.extensionBindingsJson,
    mcpDirectTools: context.mcpDirectTools,
  };
}
