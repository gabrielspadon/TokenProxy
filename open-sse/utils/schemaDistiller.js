// Annotation removal is an explicit lossy option. Descriptions, defaults and
// examples are model-readable instructions even when validators ignore them.
// Safe mode leaves the schema intact; there is no whitespace to recover from
// an already-parsed schema without modifying literal values.
const MIN_BYTES = 8192;
const STRIP_KEYS = new Set(["default", "examples", "example", "title"]);
const NAME_MAP_KEYS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const SCHEMA_KEYS = new Set(["items", "additionalItems", "additionalProperties", "unevaluatedItems", "unevaluatedProperties", "contains", "not", "if", "then", "else", "propertyNames", "contentSchema"]);
const SCHEMA_ARRAY_KEYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

function distillNode(node, notes) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return structuredClone(node);
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (STRIP_KEYS.has(key)) {
      notes.add(`stripped:${key}`);
      continue;
    }
    let copied;
    if (NAME_MAP_KEYS.has(key) || key === "dependencies") {
      copied = value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, distillNode(schema, notes)]))
        : structuredClone(value);
    } else if (SCHEMA_ARRAY_KEYS.has(key) || (key === "items" && Array.isArray(value))) {
      copied = Array.isArray(value) ? value.map((schema) => distillNode(schema, notes)) : structuredClone(value);
    } else if (SCHEMA_KEYS.has(key)) {
      copied = distillNode(value, notes);
    } else {
      // enum/const and extension annotations contain DATA, not schemas. A data
      // property called title/default/description must survive byte for byte.
      copied = structuredClone(value);
    }
    Object.defineProperty(out, key, { value: copied, enumerable: true, configurable: true, writable: true });
  }
  return out;
}

/**
 * @param {Array} tools tool array in any of the wire shapes the savers see
 * @returns {{tools: Array, savedBytes: number, notes: string[]}}
 *   tools is a distilled deep copy when the stage engaged and saved bytes,
 *   otherwise the INPUT ARRAY ITSELF (unchanged, savedBytes 0) — callers can
 *   always assign the result, mutation-free by construction.
 */
export function distillToolSchemas(tools, { allowLossy = false } = {}) {
  if (!allowLossy) return { tools, savedBytes: 0, notes: [], semanticPreserving: true };
  try {
    return distillLossy(tools);
  } catch {
    return { tools, savedBytes: 0, notes: [], semanticPreserving: true };
  }
}

function distillLossy(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return { tools, savedBytes: 0, notes: [] };
  }
  const before = Buffer.byteLength(JSON.stringify(tools), "utf8");
  if (before < MIN_BYTES) {
    return { tools, savedBytes: 0, notes: [] };
  }
  const notes = new Set();
  const copy = tools.map((tool) => {
    if (!tool || typeof tool !== "object") return tool;
    const { input_schema, inputSchema, ...rest } = tool;
    const out = { ...rest };
    for (const [key, schema] of [["input_schema", input_schema], ["inputSchema", inputSchema]]) {
      if (schema && typeof schema === "object") out[key] = distillNode(schema, notes);
      else if (schema !== undefined) out[key] = schema;
    }
    // Shape-specific schema homes (Responses API / Gemini) get the same
    // treatment: keywords dropped recursively, nothing else touched.
    for (const key of ["parameters", "schema"]) {
      if (tool[key] && typeof tool[key] === "object") out[key] = distillNode(tool[key], notes);
    }
    // OpenAI function shape nests the schema one level deeper; the wrapper's
    // name/description are model-read text and stay verbatim.
    if (tool.function && typeof tool.function === "object") {
      const fn = { ...tool.function };
      for (const key of ["parameters", "schema"]) {
        if (fn[key] && typeof fn[key] === "object") fn[key] = distillNode(fn[key], notes);
      }
      out.function = fn;
    }
    return out;
  });
  const after = Buffer.byteLength(JSON.stringify(copy), "utf8");
  const savedBytes = Math.max(0, before - after);
  // Second pass over an already-distilled array must be a fixed point; if a
  // shape quirk made it not one, report honestly instead of looping.
  return { tools: savedBytes > 0 ? copy : tools, savedBytes, notes: [...notes], semanticPreserving: savedBytes === 0 };
}
