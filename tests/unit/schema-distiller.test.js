import { describe, it, expect } from "vitest";
import { distillToolSchemas as distillWithPolicy } from "../../open-sse/utils/schemaDistiller.js";

// Annotation-removal fixtures exercise explicit lossy consent.
const distillToolSchemas = (tools) => distillWithPolicy(tools, { allowLossy: true });

const NOISE_KEYS = ["default", "examples", "example", "title"];

function bigTool({ pad = 9000 } = {}) {
  return {
    name: "read_file",
    description: "Reads a file  from disk", // single-run spaces preserved
    input_schema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      title: "ReadFileArgs",
      properties: {
        path: {
          type: "string",
          description: "The file   path\n\nto read",
          title: "PathArg",
          default: "x".repeat(pad),
          examples: ["/etc/hostname"],
        },
        limit: {
          type: "integer",
          examples: [10, 20],
        },
        nested: {
          type: "array",
          items: {
            type: "object",
            properties: {
              deep: { type: "string", default: "y".repeat(200), title: "Deep" },
            },
            required: ["deep"],
            additionalProperties: false,
          },
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  };
}

function bigToolsArray() {
  return [bigTool()];
}

describe("distillToolSchemas", () => {
  it("strips four annotation keywords and keeps dialect and structural keywords", () => {
    const { tools, savedBytes, notes } = distillToolSchemas(bigToolsArray());
    expect(savedBytes).toBeGreaterThan(0);
    expect(notes.join(" ")).toContain("stripped:default");
    const schema = tools[0].input_schema;
    for (const key of NOISE_KEYS) {
      expect(JSON.stringify(schema)).not.toContain(`"${key}"`);
    }
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["path"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.limit.type).toBe("integer");
    expect(schema.properties.nested.items.required).toEqual(["deep"]);
    expect(schema.properties.nested.items.additionalProperties).toBe(false);
    expect(schema.properties.nested.items.properties.deep.type).toBe("string");
  });

  it("preserves whitespace inside all descriptions", () => {
    const { tools } = distillToolSchemas(bigToolsArray());
    expect(tools[0].input_schema.properties.path.description).toBe("The file   path\n\nto read");
    // tool.description is outside input_schema: never touched, even with runs
    expect(tools[0].description).toBe("Reads a file  from disk");
    expect(tools[0].name).toBe("read_file");
  });

  it("never mutates the caller's array", () => {
    const input = bigToolsArray();
    const before = JSON.stringify(input);
    distillToolSchemas(input);
    expect(JSON.stringify(input)).toBe(before);
    // original keywords still there
    expect(input[0].input_schema.properties.path.default).toHaveLength(9000);
    expect(input[0].input_schema.$schema).toBeTruthy();
  });

  it("returns the input unchanged below the 8KB floor", () => {
    const input = [
      {
        name: "small",
        description: "tiny",
        input_schema: { type: "object", default: "y".repeat(100), title: "T" },
      },
    ];
    expect(JSON.stringify(input).length).toBeLessThan(8192);
    const out = distillToolSchemas(input);
    expect(out.tools).toBe(input); // same reference, zero work
    expect(out.savedBytes).toBe(0);
    expect(out.notes).toEqual([]);
  });

  it("engages at exactly the 8KB boundary", () => {
    const tool = bigTool({ pad: 0 });
    // pad a default until the array hits the floor
    let pad = 0;
    while (JSON.stringify([tool]).length < 8192) {
      pad += 100;
      tool.input_schema.properties.path.default = "x".repeat(pad);
    }
    const input = [tool];
    expect(JSON.stringify(input).length).toBeGreaterThanOrEqual(8192);
    const out = distillToolSchemas(input);
    expect(out.savedBytes).toBeGreaterThan(0);
    expect(out.tools[0].input_schema.properties.path.default).toBeUndefined();
  });

  it("second pass is a fixed point (idempotent)", () => {
    const first = distillToolSchemas(bigToolsArray());
    const second = distillToolSchemas(first.tools);
    expect(second.savedBytes).toBe(0);
    expect(second.tools).toBe(first.tools);
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
  });

  it("handles empty and non-array input without engaging", () => {
    expect(distillToolSchemas([])).toEqual({ tools: [], savedBytes: 0, notes: [] });
    const notArray = null;
    expect(distillToolSchemas(notArray).savedBytes).toBe(0);
  });

  it("preserves non-object entries and passthrough schema fields", () => {
    const input = bigToolsArray();
    input.push("literal", null, 42);
    const { tools } = distillToolSchemas(input);
    expect(tools[1]).toBe("literal");
    expect(tools[2]).toBeNull();
    expect(tools[3]).toBe(42);
  });

  it("supports OpenAI parameters and Responses-schema shapes too", () => {
    const fn = {
      type: "function",
      function: {
        name: "f",
        description: "fn",
        parameters: {
          type: "object",
          title: "Params",
          properties: { a: { type: "string", default: "z".repeat(9000) } },
        },
      },
    };
    const { tools } = distillToolSchemas([fn]);
    expect(JSON.stringify(tools[0].function.parameters)).not.toContain('"title"');
    expect(JSON.stringify(tools[0].function.parameters)).not.toContain('"default"');
    expect(tools[0].function.name).toBe("f");
    expect(tools[0].function.description).toBe("fn");
  });
});

describe("property names colliding with STRIP_KEYS", () => {
  function collisionTool({ pad = 9000 } = {}) {
    return {
      name: "collide",
      description: "d",
      input_schema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            title: "InnerTitle",
            default: "z".repeat(pad),
            description: "a property   named title",
          },
          default: { type: "integer", examples: [1, 2] },
          example: { type: "boolean", default: true },
          examples: { type: "array", items: { type: "string", title: "Item" } },
        },
        required: ["title", "default", "example", "examples"],
      },
    };
  }

  it("keeps properties named title/default/example/examples, strips keywords inside their values", () => {
    const { tools, savedBytes } = distillToolSchemas([collisionTool()]);
    expect(savedBytes).toBeGreaterThan(0);
    const schema = tools[0].input_schema;
    // property names survive
    expect(Object.keys(schema.properties).sort()).toEqual(["default", "example", "examples", "title"]);
    expect(schema.required).toEqual(["title", "default", "example", "examples"]);
    // keyword stripping still applies inside each property value
    expect(schema.properties.title.default).toBeUndefined();
    expect(schema.properties.title.title).toBeUndefined();
    expect(schema.properties.title.description).toBe("a property   named title");
    expect(schema.properties.default.examples).toBeUndefined();
    expect(schema.properties.example.default).toBeUndefined();
    expect(schema.properties.examples.items.title).toBeUndefined();
    expect(schema.properties.examples.type).toBe("array");
  });

  it("name-map protection nests through arrays and $defs", () => {
    const tool = collisionTool();
    tool.input_schema.$defs = {
      default: { type: "object", properties: { example: { type: "string", default: "q".repeat(9000) } } },
    };
    const { tools } = distillToolSchemas([tool]);
    const defs = tools[0].input_schema.$defs;
    expect(defs.default.type).toBe("object");
    expect(defs.default.properties.example.type).toBe("string");
    expect(defs.default.properties.example.default).toBeUndefined();
  });
});

describe("__proto__ property names survive distillation (audit finding 12)", () => {
  it("a property literally named __proto__ stays an own property, with no prototype swap", () => {
    // JSON.parse (not a literal) is what puts "__proto__" in as an own
    // property, the way a real wire body carries it.
    const schema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string","title":"drop me"},"title":{"type":"string"}}}',
    );
    const pad = "z".repeat(9000);
    const tools = [{ name: "t", description: pad, input_schema: schema }];
    const { tools: distilled } = distillToolSchemas(tools);
    const props = distilled[0].input_schema.properties;
    expect(Object.prototype.hasOwnProperty.call(props, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(props)).toBe(Object.prototype);
    expect(props.__proto__).toEqual({ type: "string" });
    // round-trips through JSON intact
    expect(JSON.parse(JSON.stringify(distilled))[0].input_schema.properties.__proto__).toEqual({
      type: "string",
    });
  });
});
