// Versioned content-free DTO, shared by capture, persistence and read-only workers.
export const CONTEXT_BOUNDARIES = ["client-received", "gateway-shaped", "physical-dispatch"];
export const CONTEXT_ROLES = ["user", "assistant", "tool", "system", "developer", "other"];
export class ContextStructureError extends Error {}
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const SCALAR_KEYS = ["bodyBytes", "messageBytes", "messageContainerBytes", "instructionBytes", "toolSchemaBytes", "envelopeBytes", "historyPrefixBytes"];
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
// A second allowlist at persistence prevents callers from adding prompt fields.
export function normalizeContextStructure(input) {
  if (!object(input) || input.version !== 1 || !CONTEXT_BOUNDARIES.includes(input.boundary)
    || !SCALAR_KEYS.every((key) => integer(input[key]))
    || input.bodyBytes !== input.messageBytes + input.instructionBytes + input.toolSchemaBytes + input.envelopeBytes) throw new ContextStructureError("Invalid structural measurement");
  const output = { version: 1, boundary: input.boundary };
  for (const key of SCALAR_KEYS) output[key] = input[key];
  for (const [group, names] of [["roles", CONTEXT_ROLES], ["subsets", ["toolCalls", "toolResults", "attachments"]]]) {
    output[group] = {};
    for (const name of names) {
      const value = input[group]?.[name];
      if (!object(value) || !integer(value.count) || !integer(value.bytes)) throw new ContextStructureError("Invalid structural measurement");
      output[group][name] = { count: value.count, bytes: value.bytes };
    }
  }
  if (Object.values(output.roles).reduce((sum, role) => sum + role.bytes, 0) + output.messageContainerBytes !== output.messageBytes) throw new ContextStructureError("Invalid role boundary");
  output.fingerprints = {};
  for (const name of ["body", "instructions", "tools", "historyPrefix"]) {
    const value = input.fingerprints?.[name];
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new ContextStructureError("Invalid structural fingerprint");
    output.fingerprints[name] = value;
  }
  return output;
}
