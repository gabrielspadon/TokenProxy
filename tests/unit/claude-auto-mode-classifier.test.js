import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { handleForcedSSEToJson } = await import(
  "../../open-sse/handlers/chatCore/sseToJsonHandler.js"
);
const { handleNonStreamingResponse } = await import(
  "../../open-sse/handlers/chatCore/nonStreamingHandler.js"
);
const { handleComboChat, resetComboRotation } = await import(
  "../../open-sse/services/combo.js"
);
const { getModelUpstreamId } = await import(
  "../../open-sse/config/providerModels.js"
);
const claudeClassifier = await import(
  "../../open-sse/handlers/chatCore/claudeClassifier.js"
);
const {
  CLAUDE_CLASSIFIER_ERROR_MESSAGE,
  ClaudeClassifierValidationError,
  isClaudeClassifierRequest,
  projectResponsesClassifierOutput,
  projectResponsesClassifierStream,
  validateClaudeClassifierMessage,
} = claudeClassifier;

const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const SYSTEM_PREFIX =
  "You are a security monitor for autonomous AI coding agents";
const STAGE_ONE_BODY = deepFreeze({
  model: "subscription",
  stream: false,
  system: `${SYSTEM_PREFIX}. Return one exact decision.`,
  stop_sequences: ["</block>"],
  messages: [{ role: "user", content: "Classify this action." }],
});
const STAGE_TWO_BODY = deepFreeze({
  model: "subscription",
  stream: false,
  system: [{ type: "text", text: `${SYSTEM_PREFIX}: verify the first result.` }],
  messages: [{ role: "user", content: "Verify this action." }],
});
const withoutStream = ({ stream: _stream, ...body }) => body;
const CLASSIFIER_ERROR = {
  error: {
    message:
      "Claude Code classifier returned an invalid decision; expected exactly <block>no</block> or <block>yes</block>.",
    type: "server_error",
    code: "bad_gateway",
  },
};
const RESPONSES_JSON_WITH_DROPPED_ITEM = deepFreeze({
  id: "resp_classifier_json_dropped_item",
  object: "response",
  created_at: 1700000000,
  model: "gpt-5.6-sol",
  status: "completed",
  output: [
    {
      id: "msg_classifier_decision",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "<block>no</block>" }],
    },
    {
      id: "tools_classifier_hidden",
      type: "additional_tools",
      tools: [{ type: "web_search" }],
    },
  ],
  usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
});

const textItem = (text) => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
});
const reasoningItem = (text) => ({
  type: "reasoning",
  summary: [{ type: "summary_text", text }],
});
const frame = (event, data, eol = "\n") =>
  `event: ${event}${eol}data: ${JSON.stringify(data)}${eol}${eol}`;
const doneFrame = (item, outputIndex = 0, eol = "\n") =>
  frame(
    "response.output_item.done",
    { type: "response.output_item.done", output_index: outputIndex, item },
    eol,
  );
const terminalFrame = (output, eol = "\n") =>
  frame(
    "response.completed",
    {
      type: "response.completed",
      response: {
        id: "resp_classifier_1700000000",
        created_at: 1700000000,
        model: "gpt-5.6-sol",
        status: "completed",
        ...(output === undefined ? {} : { output }),
        usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
      },
    },
    eol,
  );
const readableFromChunks = (chunks) =>
  new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
const readableFromBytes = (chunks) =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
const projectionEntry = ({
  kind,
  eventOrdinal = null,
  outputIndex = null,
  itemIndex = null,
  blockIndex = null,
  type = null,
  text = null,
}) => ({
  kind,
  eventOrdinal,
  outputIndex,
  itemIndex,
  blockIndex,
  type,
  text,
});
const forcedResponsesContext = (body, chunks, {
  sourceFormat = FORMATS.CLAUDE,
  targetFormat = FORMATS.OPENAI_RESPONSES,
  provider = "codex",
} = {}) => ({
  providerResponse: new Response(readableFromChunks(chunks), {
    headers: { "content-type": "text/event-stream" },
  }),
  sourceFormat,
  targetFormat,
  provider,
  model: "gpt-5.6-sol",
  body,
  stream: false,
  translatedBody: null,
  finalBody: null,
  requestStartTime: 1700000000000,
  connectionId: "classifier-test-connection",
  apiKey: "classifier-test-key",
  clientRawRequest: { endpoint: "/v1/messages", body },
  onRequestSuccess: vi.fn(async () => {}),
  customToolNames: null,
  trackDone: vi.fn(),
  appendLog: vi.fn(),
  reqTag: "classifier-test",
  log: null,
});
const jsonProviderResponse = (responseBody) => new Response(
  JSON.stringify(responseBody),
  { headers: { "content-type": "application/json" } },
);
const openAICompletion = (content) => ({
  id: "chatcmpl_classifier_1700000000",
  object: "chat.completion",
  created: 1700000000,
  model: "gpt-5.6-sol",
  choices: [{
    index: 0,
    message: { role: "assistant", content },
    finish_reason: "stop",
  }],
  usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
});
const openAICompletionMessage = (message, {
  id = "chatcmpl_classifier_1700000000",
  finishReason = "stop",
} = {}) => ({
  id,
  object: "chat.completion",
  created: 1700000000,
  model: "gpt-5.6-sol",
  choices: [{ index: 0, message, finish_reason: finishReason }],
  usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
});
const nativeClaudeMessage = (content) => ({
  id: "msg_classifier_1700000000",
  type: "message",
  role: "assistant",
  model: "gpt-5.6-sol",
  content,
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 8, output_tokens: 2 },
});
const responsesJson = (output, {
  id = "resp_classifier_1700000000",
  status = "completed",
  usage = { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
  ...extra
} = {}) => ({
  id,
  object: "response",
  created_at: 1700000000,
  model: "gpt-5.6-sol",
  status,
  ...(output === undefined ? {} : { output }),
  usage,
  ...extra,
});
const nonStreamingContext = ({
  body = STAGE_ONE_BODY,
  providerResponse,
  sourceFormat = FORMATS.CLAUDE,
  targetFormat = FORMATS.OPENAI,
  provider = "op-test-chat",
} = {}) => ({
  providerResponse,
  provider,
  model: "gpt-5.6-sol",
  sourceFormat,
  targetFormat,
  body,
  stream: false,
  translatedBody: null,
  finalBody: null,
  requestStartTime: 1700000000000,
  connectionId: "classifier-test-connection",
  apiKey: "classifier-test-key",
  clientRawRequest: { endpoint: "/v1/messages", body },
  onRequestSuccess: vi.fn(async () => {}),
  reqLogger: {
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
  },
  toolNameMap: null,
  customToolNames: null,
  trackDone: vi.fn(),
  appendLog: vi.fn(),
  pxpipe: null,
  reqTag: "classifier-test",
  log: null,
});
const classifierCallSpies = () => ({
  detect: vi.spyOn(claudeClassifier, "isClaudeClassifierRequest"),
  output: vi.spyOn(claudeClassifier, "projectResponsesClassifierOutput"),
  stream: vi.spyOn(claudeClassifier, "projectResponsesClassifierStream"),
  validate: vi.spyOn(claudeClassifier, "validateClaudeClassifierMessage"),
});
const expectNoClassifierCalls = (spies) => {
  for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
};
const restoreClassifierSpies = (spies) => {
  for (const spy of Object.values(spies)) spy.mockRestore();
};
const runWithoutClassifierCalls = async (run) => {
  const spies = classifierCallSpies();
  try {
    const result = await run();
    expectNoClassifierCalls(spies);
    return result;
  } finally {
    restoreClassifierSpies(spies);
  }
};

const CHAT_HANDLER_MOCKS = [
  "open-sse/index.js",
  "@/sse/services/auth.js",
  "@/lib/localDb",
  "@/sse/services/model.js",
  "open-sse/handlers/chatCore.js",
  "open-sse/services/combo.js",
  "open-sse/services/capacityAdapter.js",
  "open-sse/utils/bypassHandler.js",
  "open-sse/services/accountFallback.js",
  "open-sse/utils/error.js",
  "open-sse/translator/formats.js",
  "@/sse/utils/logger.js",
  "@/sse/services/tokenRefresh.js",
  "open-sse/services/projectId.js",
  "@/lib/claudeCompat",
  "@/lib/headroom/detect",
  "@/lib/pxpipe/loader.js",
  "@/lib/pxpipe/events.js",
  "@/lib/tokenSaver/events.js",
];
const unloadChatHandler = () => {
  for (const moduleName of CHAT_HANDLER_MOCKS) vi.doUnmock(moduleName);
  vi.resetModules();
};
const terminalChatRequest = () => new Request("http://localhost/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "codex/gpt-5.6-sol",
    messages: [{ role: "user", content: "Classify this action." }],
  }),
});
const terminalCredentials = {
  connectionId: "classifier-account",
  connectionName: "classifier-account",
  apiKey: "provider-key",
  providerSpecificData: {},
};
async function loadTerminalChatHandler({ coreResult, shouldFallback = false }) {
  const mocks = {
    appendPxpipeEvent: vi.fn(),
    appendTokenSaverEvent: vi.fn(),
    checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials),
    clearAccountError: vi.fn(),
    detectRequiredCapabilities: vi.fn(() => new Set()),
    getComboModels: vi.fn(async () => null),
    getModelInfo: vi.fn(async () => ({ provider: "codex", model: "gpt-5.6-sol" })),
    getProviderCredentials: vi.fn(async () => terminalCredentials),
    getSettings: vi.fn(async () => ({
      requireApiKey: false,
      providerThinking: {},
      providerStrategies: {},
      ccFilterNaming: false,
      rtkEnabled: false,
      headroomEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      pxpipeEnabled: false,
    })),
    handleChatCore: vi.fn(async () => coreResult),
    markAccountUnavailable: vi.fn(async () => ({ shouldFallback })),
    updateProviderCredentials: vi.fn(),
  };

  vi.resetModules();
  vi.doMock("open-sse/index.js", () => ({}));
  vi.doMock("@/sse/services/auth.js", () => ({
    clearAccountError: mocks.clearAccountError,
    extractApiKey: () => null,
    getProviderCredentials: mocks.getProviderCredentials,
    isValidApiKey: vi.fn(async () => true),
    markAccountUnavailable: mocks.markAccountUnavailable,
  }));
  vi.doMock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
  // The disabled-model check on the chat path (#577) reads the DB, and the
  // sqlite adapter arms a WAL-checkpoint interval when it first initialises.
  // Under fake timers that interval shows up as a pending timer, which is the
  // adapter's own lifetime timer rather than anything this abort path
  // scheduled. Stub the lookup so the assertion stays about scheduling.
  vi.doMock("@/lib/disabledModelsDb", () => ({
    getDisabledModels: async () => ({}),
    getDisabledByProvider: async () => [],
    disableModels: async () => {},
    enableModels: async () => {},
  }));
  // Spread the real module: a partial mock fails the WHOLE file the moment
  // the module gains an export it does not name (#577 added isModelDisabled).
  vi.doMock("@/sse/services/model.js", async (importOriginal) => ({
    ...(await importOriginal()),
    getComboModels: mocks.getComboModels,
    getModelInfo: mocks.getModelInfo,
  }));
  vi.doMock("open-sse/handlers/chatCore.js", () => ({
    handleChatCore: mocks.handleChatCore,
  }));
  // Spread the real module: the chat handler imports more from it than these
  // three, and a mock that returns only some fails the whole file.
  vi.doMock("open-sse/services/combo.js", async (importOriginal) => ({
    ...(await importOriginal()),
    detectRequiredCapabilities: mocks.detectRequiredCapabilities,
    handleComboChat: vi.fn(),
    handleFusionChat: vi.fn(),
  }));
  vi.doMock("open-sse/services/capacityAdapter.js", () => ({
    augmentModelsWithCapacityAdapter: vi.fn((models) => models),
    getActiveAdapterStrategy: vi.fn(),
    withCapacityAdapterStripping: vi.fn((handler) => handler),
  }));
  vi.doMock("open-sse/utils/bypassHandler.js", () => ({
    handleBypassRequest: vi.fn(() => null),
  }));
  vi.doMock("open-sse/services/accountFallback.js", () => ({
    isRequestReplayBufferError: vi.fn(() => false),
  }));
  vi.doMock("open-sse/utils/error.js", () => ({
    errorResponse: (status, message) => Response.json({ error: { message } }, { status }),
    unavailableResponse: (status, message) => Response.json({ error: { message } }, { status }),
  }));
  vi.doMock("open-sse/translator/formats.js", () => ({
    detectFormatByEndpoint: vi.fn(() => FORMATS.OPENAI),
  }));
  vi.doMock("@/sse/utils/logger.js", () => ({
    debug: vi.fn(),
    info: vi.fn(),
    maskKey: vi.fn(() => "***"),
    warn: vi.fn(),
  }));
  vi.doMock("@/sse/services/tokenRefresh.js", () => ({
    checkAndRefreshToken: mocks.checkAndRefreshToken,
    updateProviderCredentials: mocks.updateProviderCredentials,
  }));
  vi.doMock("open-sse/services/projectId.js", () => ({
    getProjectIdForConnection: vi.fn(),
  }));
  vi.doMock("@/lib/claudeCompat", () => ({
    buildClaudeRoutingIndex: vi.fn(),
    looksLikeClaudeWrappedModel: vi.fn(() => false),
    normalizeClaudeModelName: vi.fn(),
    readClaudeCompat: vi.fn(() => ({ enabled: false })),
    // chat.js strips the [1m] context suffix ahead of, and outside, the
    // compat-gated block, so the mock has to supply it even though this suite
    // runs with compat disabled. Identity: these fixtures carry no suffix.
    stripContextSuffix: vi.fn((m) => m),
  }));
  vi.doMock("@/lib/headroom/detect", () => ({
    DEFAULT_HEADROOM_URL: "http://headroom.invalid",
    parseHeadroomTimeoutMs: vi.fn(() => 0),
  }));
  vi.doMock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn() }));
  vi.doMock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: mocks.appendPxpipeEvent }));
  vi.doMock("@/lib/tokenSaver/events.js", () => ({ appendTokenSaverEvent: mocks.appendTokenSaverEvent }));

  const { handleChat } = await import("../../src/sse/handlers/chat.js");
  return { handleChat, mocks };
}

const claudeMessage = (content) => ({
  id: "msg_classifier_1700000000",
  type: "message",
  role: "assistant",
  model: "gpt-5.6-sol",
  content,
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 8, output_tokens: 2 },
  extension: { retained: true },
});

describe("Claude classifier request detector", () => {
  it.each([
    ["stage one string", STAGE_ONE_BODY],
    [
      "stage one first system block",
      {
        ...withoutStream(STAGE_ONE_BODY),
        system: [{ type: "text", text: `${SYSTEM_PREFIX} valid.` }],
        stop_sequences: ["other", "  </block>  "],
      },
    ],
    [
      "stage two string",
      { ...STAGE_TWO_BODY, system: `${SYSTEM_PREFIX} valid stage two.` },
    ],
    [
      "stage two empty stops",
      { ...withoutStream(STAGE_TWO_BODY), stop_sequences: [] },
    ],
  ])("detects %s", (_name, body) => {
    const before = structuredClone(body);
    deepFreeze(body);
    expect(isClaudeClassifierRequest(body)).toBe(true);
    expect(body).toEqual(before);
  });

  it.each([
    ["end", SYSTEM_PREFIX],
    ["whitespace", `${SYSTEM_PREFIX}\ncontinue`],
    ["period", `${SYSTEM_PREFIX}. continue`],
    ["colon", `${SYSTEM_PREFIX}: continue`],
  ])("detects exact prefix boundary %s", (_name, system) => {
    expect(isClaudeClassifierRequest({ system })).toBe(true);
  });

  it.each([
    ["null", null],
    ["boolean", true],
    ["number", 1],
    ["string", SYSTEM_PREFIX],
    ["array", [{ system: SYSTEM_PREFIX }]],
  ])("rejects non-object body %s", (_name, body) => {
    expect(isClaudeClassifierRequest(body)).toBe(false);
  });

  it.each([undefined, true, null, "false", 0, [], {}])(
    "rejects stream value %j",
    (stream) => {
      expect(isClaudeClassifierRequest({ ...STAGE_ONE_BODY, stream })).toBe(false);
    },
  );

  it.each([
    ["leading whitespace", ` ${SYSTEM_PREFIX}`],
    ["changed case", SYSTEM_PREFIX.toUpperCase()],
    ["generic phrase", "You are a security monitor"],
    ["alphanumeric continuation", `${SYSTEM_PREFIX}Extra`],
  ])("rejects system near miss %s", (_name, system) => {
    expect(
      isClaudeClassifierRequest({ ...STAGE_ONE_BODY, system }),
    ).toBe(false);
  });

  it.each([
    [
      "later system block",
      {
        ...STAGE_ONE_BODY,
        system: [
          { type: "text", text: "ordinary" },
          { type: "text", text: SYSTEM_PREFIX },
        ],
      },
    ],
    [
      "role-system message",
      {
        ...STAGE_ONE_BODY,
        system: "ordinary",
        messages: [{ role: "system", content: SYSTEM_PREFIX }],
      },
    ],
    [
      "user block",
      {
        ...STAGE_ONE_BODY,
        system: "ordinary",
        messages: [{ role: "user", content: SYSTEM_PREFIX }],
      },
    ],
    [
      "assistant block",
      {
        ...STAGE_ONE_BODY,
        system: "ordinary",
        messages: [{ role: "assistant", content: SYSTEM_PREFIX }],
      },
    ],
    [
      "tool-result block",
      {
        ...STAGE_ONE_BODY,
        system: "ordinary",
        messages: [{ role: "user", content: [{ type: "tool_result", content: SYSTEM_PREFIX }] }],
      },
    ],
    [
      "image block",
      {
        ...STAGE_ONE_BODY,
        system: "ordinary",
        messages: [{ role: "user", content: [{ type: "image", source: { data: SYSTEM_PREFIX } }] }],
      },
    ],
    [
      "unknown block",
      {
        ...STAGE_ONE_BODY,
        system: "ordinary",
        messages: [{ role: "user", content: [{ type: "future", text: SYSTEM_PREFIX }] }],
      },
    ],
  ])("does not scan %s", (_name, body) => {
    expect(isClaudeClassifierRequest(body)).toBe(false);
  });

  it.each([
    ["empty array", []],
    ["non-text first block", [{ type: "image", text: SYSTEM_PREFIX }]],
    ["missing first text", [{ type: "text" }]],
    ["non-string first text", [{ type: "text", text: 42 }]],
  ])("rejects invalid system array %s", (_name, system) => {
    expect(isClaudeClassifierRequest({ ...STAGE_ONE_BODY, system })).toBe(false);
  });

  it.each([
    ["null", null],
    ["string", "</block>"],
    ["number", 1],
    ["object", { stop: "</block>" }],
    ["wrong array", ["stop"]],
    ["substring", ["before </block> after"]],
    ["case variant", ["</BLOCK>"]],
  ])("rejects stop_sequences %s", (_name, stop_sequences) => {
    expect(
      isClaudeClassifierRequest({ ...STAGE_ONE_BODY, stop_sequences }),
    ).toBe(false);
  });

  it("rejects a sentinel without the prefix", () => {
    expect(
      isClaudeClassifierRequest({
        ...STAGE_ONE_BODY,
        system: "ordinary classifier request",
      }),
    ).toBe(false);
  });

  it("rejects a prefix quoted later in an ordinary prompt", () => {
    expect(
      isClaudeClassifierRequest({
        ...STAGE_ONE_BODY,
        system: `Ordinary instructions quote: ${SYSTEM_PREFIX}`,
      }),
    ).toBe(false);
  });
});

describe("direct Claude classifier Message validation", () => {
  it.each([
    ["allow", "<block>no</block>", "<block>no</block>"],
    ["deny", "<block>yes</block>", "<block>yes</block>"],
    ["allow outer whitespace", " \n<block>no</block>\t", "<block>no</block>"],
    ["deny outer whitespace", "\t<block>yes</block> \n", "<block>yes</block>"],
  ])("validates classifier Messages directly: %s", (_name, text, expected) => {
    const message = deepFreeze(claudeMessage([{ type: "text", text }]));
    const before = structuredClone(message);

    const result = validateClaudeClassifierMessage(STAGE_ONE_BODY, message);

    expect(result).not.toBe(message);
    expect(result.content).not.toBe(message.content);
    expect(result).toEqual({
      ...before,
      content: [{ type: "text", text: expected }],
    });
    expect(message).toEqual(before);
  });

  it.each([
    [
      "thinking plus decision",
      [
        { type: "thinking", thinking: "private reasoning" },
        { type: "text", text: "<block>no</block>" },
      ],
    ],
    [
      "redacted thinking plus decision",
      [
        { type: "redacted_thinking", data: "encrypted" },
        { type: "text", text: "<block>yes</block>" },
      ],
    ],
  ])("validates classifier Messages directly: %s", (_name, content) => {
    const message = deepFreeze(claudeMessage(content));
    const before = structuredClone(message);

    const result = validateClaudeClassifierMessage(STAGE_ONE_BODY, message);

    expect(result.content).toEqual([content.at(-1)]);
    expect(message).toEqual(before);
  });

  it("validates classifier Messages directly: bypasses a non-classifier by identity", () => {
    const body = { ...STAGE_ONE_BODY, system: "ordinary" };
    const message = claudeMessage([{ type: "text", text: "ordinary prose" }]);
    expect(validateClaudeClassifierMessage(body, message)).toBe(message);
  });

  it.each([
    ["missing Message", undefined, null],
    ["array Message", [], null],
    ["wrong type", { ...claudeMessage([]), type: "response" }, null],
    ["wrong role", { ...claudeMessage([]), role: "user" }, null],
    ["missing content", { ...claudeMessage([]), content: undefined }, null],
    ["non-array content", { ...claudeMessage([]), content: "text" }, null],
    ["empty content", claudeMessage([]), null],
    ["empty text", claudeMessage([{ type: "text", text: "" }]), ""],
    ["whitespace text", claudeMessage([{ type: "text", text: "  " }]), "  "],
    ["prose", claudeMessage([{ type: "text", text: "This looks safe to me." }]), "This looks safe to me."],
    ["case variant", claudeMessage([{ type: "text", text: "<BLOCK>no</BLOCK>" }]), "<BLOCK>no</BLOCK>"],
    ["prefix text", claudeMessage([{ type: "text", text: `prefix <block>no</block>` }]), "prefix"],
    ["suffix text", claudeMessage([{ type: "text", text: `<block>no</block> suffix` }]), "suffix"],
    ["two tags", claudeMessage([{ type: "text", text: "<block>no</block><block>no</block>" }]), "<block>no</block><block>no</block>"],
    ["two text blocks", claudeMessage([{ type: "text", text: "<block>no</block>" }, { type: "text", text: "<block>yes</block>" }]), null],
    ["thinking only", claudeMessage([{ type: "thinking", thinking: "private" }]), null],
    ["malformed thinking", claudeMessage([{ type: "thinking", thinking: 1 }, { type: "text", text: "<block>no</block>" }]), null],
    ["malformed redacted thinking", claudeMessage([{ type: "redacted_thinking", data: null }, { type: "text", text: "<block>no</block>" }]), null],
    ["tool use", claudeMessage([{ type: "tool_use", id: "tool_1", name: "shell", input: {} }]), null],
    ["image", claudeMessage([{ type: "image", source: { type: "base64", data: "AA==" } }]), null],
    ["document", claudeMessage([{ type: "document", source: { type: "text", data: "doc" } }]), null],
    ["tool result", claudeMessage([{ type: "tool_result", tool_use_id: "tool_1", content: "ok" }]), null],
    ["unknown block", claudeMessage([{ type: "future", value: 1 }]), null],
    ["decision plus tool", claudeMessage([{ type: "text", text: "<block>no</block>" }, { type: "tool_use", id: "tool_1", name: "shell", input: {} }]), null],
    ["decision plus unknown", claudeMessage([{ type: "text", text: "<block>no</block>" }, { type: "future" }]), null],
  ])("validates classifier Messages directly: rejects %s", (_name, rawMessage, leakedText) => {
    const message = deepFreeze(rawMessage);
    const before = message === undefined ? undefined : structuredClone(message);
    let error;

    try {
      validateClaudeClassifierMessage(STAGE_ONE_BODY, message);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ClaudeClassifierValidationError);
    expect(error.code).toBe("CLAUDE_CLASSIFIER_INVALID_DECISION");
    expect(error.message).toBe(CLAUDE_CLASSIFIER_ERROR_MESSAGE);
    if (leakedText) expect(error.message).not.toContain(leakedText);
    expect(message).toEqual(before);
  });

  it("rejects unresolved frozen projection evidence without mutating caller data", () => {
    const message = deepFreeze(claudeMessage([{ type: "text", text: "<block>no</block>" }]));
    const projection = deepFreeze({
      entries: [projectionEntry({ kind: "text", text: "<block>no</block>" })],
      evidence: [{ eventOrdinal: 0, resolved: false }],
    });
    const projectionBefore = structuredClone(projection);

    expect(() => validateClaudeClassifierMessage(STAGE_ONE_BODY, message, projection))
      .toThrow(ClaudeClassifierValidationError);
    expect(projection).toEqual(projectionBefore);
  });
});

describe("lossless Responses classifier projection", () => {
  it("projects ordered JSON reasoning and decision blocks without conversion loss", () => {
    const projection = projectResponsesClassifierOutput(STAGE_ONE_BODY, {
      output: [reasoningItem("private"), textItem("<block>no</block>")],
    });

    expect(projection).toEqual({
      entries: [
        projectionEntry({
          kind: "thinking",
          itemIndex: 0,
          blockIndex: 0,
          type: "summary_text",
          text: "private",
        }),
        projectionEntry({
          kind: "text",
          itemIndex: 1,
          blockIndex: 0,
          type: "output_text",
          text: "<block>no</block>",
        }),
      ],
      evidence: [],
    });
  });

  it("projects terminal Responses SSE items before the converter selects a message", async () => {
    const projection = await projectResponsesClassifierStream(
      STAGE_ONE_BODY,
      readableFromChunks([
        doneFrame(textItem("<block>yes</block>")),
        terminalFrame(),
      ]),
    );

    expect(projection).toEqual({
      entries: [
        projectionEntry({
          kind: "text",
          eventOrdinal: 0,
          outputIndex: 0,
          itemIndex: 0,
          blockIndex: 0,
          type: "output_text",
          text: "<block>yes</block>",
        }),
      ],
      evidence: [],
    });
  });

  it("keeps every JSON message and content block distinct in output order", () => {
    const projection = projectResponsesClassifierOutput(STAGE_ONE_BODY, {
      output: [
        textItem("<block>no</block>"),
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "<block>yes</block>" },
            { type: "output_text", text: "<block>no</block>" },
          ],
        },
      ],
    });

    expect(projection.entries).toEqual([
      projectionEntry({
        kind: "text",
        itemIndex: 0,
        blockIndex: 0,
        type: "output_text",
        text: "<block>no</block>",
      }),
      projectionEntry({
        kind: "text",
        itemIndex: 1,
        blockIndex: 0,
        type: "output_text",
        text: "<block>yes</block>",
      }),
      projectionEntry({
        kind: "text",
        itemIndex: 1,
        blockIndex: 1,
        type: "output_text",
        text: "<block>no</block>",
      }),
    ]);
  });

  it.each([
    ["function call", { type: "function_call", id: "fc_1" }, "function_call"],
    ["custom tool call", { type: "custom_tool_call", id: "ctc_1" }, "custom_tool_call"],
    ["function call output", { type: "function_call_output", call_id: "fc_1" }, "function_call_output"],
    ["custom tool output", { type: "custom_tool_call_output", call_id: "ctc_1" }, "custom_tool_call_output"],
    ["additional tools", { type: "additional_tools", tools: [] }, "additional_tools"],
    ["unknown tool shape", { type: "server_tool_call", id: "stc_1" }, "server_tool_call"],
  ])("classifies JSON %s as actionable", (_name, item, type) => {
    const projection = projectResponsesClassifierOutput(STAGE_ONE_BODY, {
      output: [item],
    });

    expect(projection.entries).toEqual([
      projectionEntry({
        kind: "actionable",
        itemIndex: 0,
        type,
      }),
    ]);
  });

  it("keeps unknown JSON items and message blocks visible", () => {
    const projection = projectResponsesClassifierOutput(STAGE_ONE_BODY, {
      output: [
        { type: "future_item", value: "hidden" },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "future_part", value: "hidden" }],
        },
      ],
    });

    expect(projection.entries).toEqual([
      projectionEntry({ kind: "unknown", itemIndex: 0, type: "future_item" }),
      projectionEntry({
        kind: "unknown",
        itemIndex: 1,
        blockIndex: 0,
        type: "future_part",
      }),
    ]);
  });

  it.each([
    ["missing output", {}],
    ["non-array output", { output: "invalid" }],
    ["empty output", { output: [] }],
    ["empty message", { output: [{ type: "message", role: "assistant", content: [] }] }],
    ["non-assistant message", { output: [{ type: "message", role: "user", content: [] }] }],
    ["malformed output text", { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: null }] }] }],
    ["null reasoning summary", { output: [{ type: "reasoning", summary: null }] }],
    ["malformed reasoning summary", { output: [{ type: "reasoning", summary: [{ type: "summary_text", text: null }] }] }],
  ])("marks malformed JSON shape %s", (_name, responseBody) => {
    const projection = projectResponsesClassifierOutput(STAGE_ONE_BODY, responseBody);
    expect(projection.entries.length).toBeGreaterThan(0);
    expect(projection.entries.some((entry) => entry.kind === "malformed")).toBe(true);
  });

  it("reconciles matching Responses fragments against authoritative terminal items", async () => {
    const message = {
      id: "msg_classifier_safe",
      ...textItem("<block>no</block>"),
    };
    const reasoning = {
      id: "rs_classifier_safe",
      ...reasoningItem("private"),
    };
    const functionCall = {
      id: "fc_classifier_safe",
      type: "function_call",
      name: "shell",
      arguments: "{\"cmd\":\"pwd\"}",
    };
    const customTool = {
      id: "ct_classifier_safe",
      type: "custom_tool_call",
      name: "shell",
      input: "pwd",
    };
    const projection = await projectResponsesClassifierStream(
      STAGE_ONE_BODY,
      readableFromChunks([
        frame("response.output_item.added", { output_index: 0, item: message }),
        frame("response.content_part.added", {
          output_index: 0,
          item_id: message.id,
          content_index: 0,
          part: { type: "output_text" },
        }),
        frame("response.output_text.delta", {
          output_index: 0,
          item_id: message.id,
          content_index: 0,
          delta: "<block>no</block>",
        }),
        frame("response.output_item.added", { output_index: 1, item: reasoning }),
        frame("response.reasoning_summary_part.added", {
          output_index: 1,
          item_id: reasoning.id,
          summary_index: 0,
          part: { type: "summary_text" },
        }),
        frame("response.reasoning_summary_text.delta", {
          output_index: 1,
          item_id: reasoning.id,
          summary_index: 0,
          delta: "private",
        }),
        frame("response.output_item.added", { output_index: 2, item: functionCall }),
        frame("response.function_call_arguments.delta", {
          output_index: 2,
          item_id: functionCall.id,
          delta: "{\"cmd\":\"pwd\"}",
        }),
        frame("response.output_item.added", { output_index: 3, item: customTool }),
        frame("response.custom_tool_call_input.delta", {
          output_index: 3,
          item_id: customTool.id,
          delta: "pwd",
        }),
        terminalFrame([message, reasoning, functionCall, customTool]),
      ]),
    );

    expect(projection.entries.some((entry) => entry.kind === "malformed")).toBe(false);
    expect(projection.evidence).toEqual([
      { eventOrdinal: 0, eventType: "response.output_item.added", outputIndex: 0, itemId: message.id, itemType: "message", blockIndex: null, blockType: null, resolved: true },
      { eventOrdinal: 1, eventType: "response.content_part.added", outputIndex: 0, itemId: message.id, itemType: "message", blockIndex: 0, blockType: "output_text", resolved: true },
      { eventOrdinal: 2, eventType: "response.output_text.delta", outputIndex: 0, itemId: message.id, itemType: "message", blockIndex: 0, blockType: "output_text", resolved: true },
      { eventOrdinal: 3, eventType: "response.output_item.added", outputIndex: 1, itemId: reasoning.id, itemType: "reasoning", blockIndex: null, blockType: null, resolved: true },
      { eventOrdinal: 4, eventType: "response.reasoning_summary_part.added", outputIndex: 1, itemId: reasoning.id, itemType: "reasoning", blockIndex: 0, blockType: "summary_text", resolved: true },
      { eventOrdinal: 5, eventType: "response.reasoning_summary_text.delta", outputIndex: 1, itemId: reasoning.id, itemType: "reasoning", blockIndex: 0, blockType: "summary_text", resolved: true },
      { eventOrdinal: 6, eventType: "response.output_item.added", outputIndex: 2, itemId: functionCall.id, itemType: "function_call", blockIndex: null, blockType: null, resolved: true },
      { eventOrdinal: 7, eventType: "response.function_call_arguments.delta", outputIndex: 2, itemId: functionCall.id, itemType: "function_call", blockIndex: null, blockType: null, resolved: true },
      { eventOrdinal: 8, eventType: "response.output_item.added", outputIndex: 3, itemId: customTool.id, itemType: "custom_tool_call", blockIndex: null, blockType: null, resolved: true },
      { eventOrdinal: 9, eventType: "response.custom_tool_call_input.delta", outputIndex: 3, itemId: customTool.id, itemType: "custom_tool_call", blockIndex: null, blockType: null, resolved: true },
    ]);
  });

  it("does not inspect JSON output or consume an SSE stream for a non-classifier", async () => {
    const throwingBody = {};
    Object.defineProperty(throwingBody, "output", {
      get() {
        throw new Error("must not inspect ordinary output");
      },
    });
    const throwingStream = {
      getReader() {
        throw new Error("must not consume ordinary stream");
      },
    };
    const ordinary = { ...STAGE_ONE_BODY, system: "ordinary" };

    expect(projectResponsesClassifierOutput(ordinary, throwingBody)).toBeNull();
    await expect(projectResponsesClassifierStream(ordinary, throwingStream)).resolves.toBeNull();
  });

  it("accepts terminal-only and matching done-plus-terminal SSE sources without duplicate entries", async () => {
    const item = {
      id: "msg_classifier_safe",
      ...textItem("<block>no</block>"),
    };
    const terminalOnly = await projectResponsesClassifierStream(
      STAGE_ONE_BODY,
      readableFromChunks([terminalFrame([item])]),
    );
    const matchingCopies = await projectResponsesClassifierStream(
      STAGE_ONE_BODY,
      readableFromChunks([doneFrame(item), terminalFrame([item])]),
    );

    expect(terminalOnly.entries).toEqual([
      projectionEntry({
        kind: "text",
        eventOrdinal: 0,
        outputIndex: 0,
        itemIndex: 0,
        blockIndex: 0,
        type: "output_text",
        text: "<block>no</block>",
      }),
    ]);
    expect(matchingCopies.entries).toEqual([
      projectionEntry({
        kind: "text",
        eventOrdinal: 0,
        outputIndex: 0,
        itemIndex: 0,
        blockIndex: 0,
        type: "output_text",
        text: "<block>no</block>",
      }),
    ]);
  });

  it("decodes split UTF-8 and data-only CRLF terminal SSE frames", async () => {
    const waveItem = textItem("<block>no</block> 🌊");
    const splitPayload = `${doneFrame(waveItem)}${terminalFrame()}`;
    const bytes = new TextEncoder().encode(splitPayload);
    const splitProjection = await projectResponsesClassifierStream(
      STAGE_ONE_BODY,
      readableFromBytes(Array.from(bytes, (byte) => Uint8Array.of(byte))),
    );
    const dataOnly = (data) => `data: ${JSON.stringify(data)}\r\n\r\n`;
    const crlfProjection = await projectResponsesClassifierStream(
      STAGE_ONE_BODY,
      readableFromChunks([
        dataOnly({ type: "response.output_item.done", output_index: 0, item: textItem("<block>yes</block>") }),
        dataOnly({
          type: "response.done",
          response: {
            id: "resp_classifier_1700000000",
            status: "done",
            usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
          },
        }),
      ]),
    );

    expect(splitProjection.entries[0]).toEqual(projectionEntry({
      kind: "text",
      eventOrdinal: 0,
      outputIndex: 0,
      itemIndex: 0,
      blockIndex: 0,
      type: "output_text",
      text: "<block>no</block> 🌊",
    }));
    expect(crlfProjection.entries[0]).toEqual(projectionEntry({
      kind: "text",
      eventOrdinal: 0,
      outputIndex: 0,
      itemIndex: 0,
      blockIndex: 0,
      type: "output_text",
      text: "<block>yes</block>",
    }));
  });

  it("preserves duplicate and gap terminal indexes before marking reconciliation malformed", async () => {
    const duplicate = await projectResponsesClassifierStream(
      STAGE_ONE_BODY,
      readableFromChunks([
        doneFrame(textItem("<block>no</block>"), 0),
        doneFrame(textItem("<block>yes</block>"), 0),
        terminalFrame(),
      ]),
    );
    const gap = await projectResponsesClassifierStream(
      STAGE_ONE_BODY,
      readableFromChunks([
        doneFrame(textItem("<block>no</block>"), 1),
        terminalFrame(),
      ]),
    );

    expect(duplicate.entries.slice(0, 2).map((entry) => entry.text)).toEqual([
      "<block>no</block>",
      "<block>yes</block>",
    ]);
    expect(duplicate.entries.some((entry) => entry.kind === "malformed")).toBe(true);
    expect(gap.entries[0].text).toBe("<block>no</block>");
    expect(gap.entries.some((entry) => entry.kind === "malformed")).toBe(true);
  });

  it.each([
    ["missing done item", frame("response.output_item.done", { type: "response.output_item.done", output_index: 0 })],
    ["invalid done index", doneFrame(textItem("<block>no</block>"), -1)],
    ["malformed JSON", "event: response.output_item.done\ndata: {not json}\n\n"],
    ["hidden item on unknown event", frame("response.future", { item: { type: "custom_tool_call", id: "ct_hidden" } })],
  ])("marks malformed terminal SSE %s", async (_name, unsafeFrame) => {
    const projection = await projectResponsesClassifierStream(
      STAGE_ONE_BODY,
      readableFromChunks([unsafeFrame, terminalFrame()]),
    );
    expect(projection.entries.some((entry) => entry.kind === "malformed")).toBe(true);
  });

  it("ignores content-free Responses metadata", async () => {
    const projection = await projectResponsesClassifierStream(
      STAGE_ONE_BODY,
      readableFromChunks([
        frame("response.created", {
          type: "response.created",
          response: { id: "resp_classifier_1700000000", status: "in_progress" },
        }),
        doneFrame(textItem("<block>no</block>")),
        terminalFrame(),
      ]),
    );

    expect(projection.entries).toEqual([
      projectionEntry({
        kind: "text",
        eventOrdinal: 1,
        outputIndex: 0,
        itemIndex: 0,
        blockIndex: 0,
        type: "output_text",
        text: "<block>no</block>",
      }),
    ]);
  });
});

describe("Claude Code response classifier validation", () => {
  it("rejects malformed classifier prose from forced Chat SSE", async () => {
    const result = await handleForcedSSEToJson({
      ...forcedResponsesContext(STAGE_ONE_BODY, [
        `data: ${JSON.stringify({
          id: "chatcmpl_classifier_1700000000",
          model: "gpt-5.6-sol",
          choices: [{ delta: { content: "This looks safe to me." }, finish_reason: null }],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "chatcmpl_classifier_1700000000",
          model: "gpt-5.6-sol",
          choices: [{ delta: {}, finish_reason: "stop" }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ]),
      targetFormat: FORMATS.OPENAI,
      provider: "op-test-chat",
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(await result.response.json()).toEqual(CLASSIFIER_ERROR);
  });

  it("rejects malformed classifier prose from OpenAI Chat JSON", async () => {
    const result = await handleNonStreamingResponse(nonStreamingContext({
      providerResponse: jsonProviderResponse(openAICompletion("This looks safe to me.")),
    }));

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(await result.response.json()).toEqual(CLASSIFIER_ERROR);
  });

  it("rejects a Responses JSON item dropped by final conversion", async () => {
    const context = nonStreamingContext({
      targetFormat: FORMATS.OPENAI_RESPONSES,
      provider: "codex",
      providerResponse: jsonProviderResponse(RESPONSES_JSON_WITH_DROPPED_ITEM),
    });
    const result = await handleNonStreamingResponse(context);

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(await result.response.json()).toEqual(CLASSIFIER_ERROR);
    await Promise.resolve();
    expect(context.onRequestSuccess).toHaveBeenCalledOnce();
    expect(context.appendLog).toHaveBeenCalledOnce();
    expect(context.appendLog).toHaveBeenCalledWith(expect.objectContaining({
      status: "200 OK",
    }));
  });

  it("rejects malformed classifier prose from native Claude JSON", async () => {
    const result = await handleNonStreamingResponse(nonStreamingContext({
      targetFormat: FORMATS.CLAUDE,
      provider: "claude",
      providerResponse: jsonProviderResponse(nativeClaudeMessage([
        { type: "text", text: "This looks safe to me." },
      ])),
    }));

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(await result.response.json()).toEqual(CLASSIFIER_ERROR);
  });

  it("rejects a hidden custom tool from unexpected Responses SSE", async () => {
    const safeItem = {
      id: "msg_classifier_safe",
      ...textItem("<block>no</block>"),
    };
    const result = await handleNonStreamingResponse(nonStreamingContext({
      targetFormat: FORMATS.OPENAI_RESPONSES,
      provider: "codex",
      providerResponse: new Response(readableFromChunks([
        doneFrame(safeItem),
        frame("response.output_item.added", {
          type: "response.output_item.added",
          output_index: 1,
          item: { id: "ct_hidden", type: "custom_tool_call", name: "shell", input: "pwd" },
        }),
        terminalFrame([safeItem]),
      ]), { headers: { "content-type": "text/event-stream" } }),
    }));

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(await result.response.json()).toEqual(CLASSIFIER_ERROR);
  });

  it("rejects malformed classifier prose from Gemini SSE", async () => {
    const raw = [
      'data: {"response":{"responseId":"gemini_classifier","modelVersion":"gemini-3.7-flash-low","candidates":[{"content":{"parts":[{"text":"This looks safe to me."}]}}]}}',
      'data: {"response":{"responseId":"gemini_classifier","modelVersion":"gemini-3.7-flash-low","candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    const result = await handleForcedSSEToJson({
      ...forcedResponsesContext(STAGE_ONE_BODY, [raw]),
      targetFormat: FORMATS.GEMINI,
      provider: "gemini",
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(await result.response.json()).toEqual(CLASSIFIER_ERROR);
  });

  it.each(["<block>no</block>", "<block>yes</block>"])(
    "keeps the forced Chat SSE decision %s as a canonical Claude Message",
    async (decision) => {
      const result = await handleForcedSSEToJson({
        ...forcedResponsesContext(STAGE_ONE_BODY, [
          `data: ${JSON.stringify({
            id: "chatcmpl-classifier_1700000000",
            created: 1700000000,
            model: "gpt-5.6-sol",
            choices: [{ delta: { content: decision }, finish_reason: null }],
          })}\n\n`,
          `data: ${JSON.stringify({
            id: "chatcmpl-classifier_1700000000",
            created: 1700000000,
            model: "gpt-5.6-sol",
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
          })}\n\n`,
          "data: [DONE]\n\n",
        ]),
        targetFormat: FORMATS.OPENAI,
        provider: "op-test-chat",
      });

      expect(result.success).toBe(true);
      expect(await result.response.json()).toEqual({
        id: "classifier_1700000000",
        type: "message",
        role: "assistant",
        model: "gpt-5.6-sol",
        content: [{ type: "text", text: decision }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 2 },
      });
    },
  );

  it.each(["<block>no</block>", "<block>yes</block>"])(
    "keeps the OpenAI Chat JSON decision %s as a canonical Claude Message",
    async (decision) => {
      const result = await handleNonStreamingResponse(nonStreamingContext({
        providerResponse: jsonProviderResponse(openAICompletion(decision)),
      }));

      expect(result.success).toBe(true);
      expect(await result.response.json()).toEqual({
        id: "chatcmpl_classifier_1700000000",
        type: "message",
        role: "assistant",
        model: "subscription",
        content: [{ type: "text", text: decision }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 2 },
      });
    },
  );

  it.each(["<block>no</block>", "<block>yes</block>"])(
    "keeps the Responses JSON decision %s as a canonical Claude Message",
    async (decision) => {
      const result = await handleNonStreamingResponse(nonStreamingContext({
        targetFormat: FORMATS.OPENAI_RESPONSES,
        provider: "codex",
        providerResponse: jsonProviderResponse(responsesJson([
          { id: "msg_classifier_decision", ...textItem(decision) },
        ])),
      }));

      expect(result.success).toBe(true);
      expect(await result.response.json()).toEqual({
        id: "classifier_1700000000",
        type: "message",
        role: "assistant",
        model: "subscription",
        content: [{ type: "text", text: decision }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 2 },
      });
    },
  );

  it.each(["<block>no</block>", "<block>yes</block>"])(
    "keeps the native Claude JSON decision %s with its Claude identity",
    async (decision) => {
      const result = await handleNonStreamingResponse(nonStreamingContext({
        targetFormat: FORMATS.CLAUDE,
        provider: "claude",
        providerResponse: jsonProviderResponse(nativeClaudeMessage([
          { type: "text", text: decision },
        ])),
      }));

      expect(result.success).toBe(true);
      expect(await result.response.json()).toEqual({
        ...nativeClaudeMessage([{ type: "text", text: decision }]),
        model: "subscription",
        usage: { input_tokens: 8, output_tokens: 2 },
      });
    },
  );

  it.each(["<block>no</block>", "<block>yes</block>"])(
    "keeps the unexpected Responses SSE decision %s as a canonical Claude Message",
    async (decision) => {
      const item = { id: "msg_classifier_sse", ...textItem(decision) };
      const result = await handleNonStreamingResponse(nonStreamingContext({
        targetFormat: FORMATS.OPENAI_RESPONSES,
        provider: "codex",
        providerResponse: new Response(readableFromChunks([
          frame("response.created", {
            type: "response.created",
            response: { id: "resp_classifier_sse", created_at: 1700000000 },
          }),
          doneFrame(item),
          terminalFrame([item]),
        ]), { headers: { "content-type": "text/event-stream" } }),
      }));

      expect(result.success).toBe(true);
      expect(await result.response.json()).toEqual({
        id: "classifier_sse",
        type: "message",
        role: "assistant",
        model: "subscription",
        content: [{ type: "text", text: decision }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 2 },
      });
    },
  );

  it.each(["<block>no</block>", "<block>yes</block>"])(
    "keeps the Gemini SSE decision %s as a canonical Claude Message",
    async (decision) => {
      const raw = [
        `data: ${JSON.stringify({
          response: {
            responseId: "gemini_classifier",
            modelVersion: "gemini-3.7-flash-low",
            usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2, totalTokenCount: 10 },
            candidates: [{ content: { parts: [{ text: decision }] }, finishReason: "STOP" }],
          },
        })}`,
        "data: [DONE]",
        "",
      ].join("\n\n");
      const result = await handleForcedSSEToJson({
        ...forcedResponsesContext(STAGE_ONE_BODY, [raw]),
        targetFormat: FORMATS.GEMINI,
        provider: "gemini",
      });

      expect(result.success).toBe(true);
      expect(await result.response.json()).toEqual({
        id: "gemini_classifier",
        type: "message",
        role: "assistant",
        model: "gemini-3.7-flash-low",
        content: [{ type: "text", text: decision }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 2 },
      });
    },
  );

  it("keeps Gemini SSE thinking beside a classifier decision canonical", async () => {
    const raw = [
      `data: ${JSON.stringify({
        response: {
          responseId: "gemini_classifier_thinking",
          modelVersion: "gemini-3.7-flash-low",
          candidates: [{
            content: {
              parts: [
                { text: "private", thought: true },
                { text: "<block>no</block>" },
              ],
            },
            finishReason: "STOP",
          }],
        },
      })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
    const result = await handleForcedSSEToJson({
      ...forcedResponsesContext(STAGE_ONE_BODY, [raw]),
      targetFormat: FORMATS.GEMINI,
      provider: "gemini",
    });

    expect(result.success).toBe(true);
    expect(await result.response.json()).toMatchObject({
      id: "gemini_classifier_thinking",
      type: "message",
      role: "assistant",
      model: "gemini-3.7-flash-low",
      content: [{ type: "text", text: "<block>no</block>" }],
      stop_reason: "end_turn",
      stop_sequence: null,
    });
  });

  it.each([
    ["no choice", { ...openAICompletion(""), choices: [] }],
    ["prose", openAICompletion("This looks safe to me.")],
    ["tool call", openAICompletionMessage({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_hidden", type: "function", function: { name: "shell", arguments: "{}" } }],
    }, { finishReason: "tool_calls" })],
    ["decision plus tool call", openAICompletionMessage({
      role: "assistant",
      content: "<block>no</block>",
      tool_calls: [{ id: "call_hidden", type: "function", function: { name: "shell", arguments: "{}" } }],
    }, { finishReason: "tool_calls" })],
  ])("rejects invalid OpenAI Chat JSON with %s", async (_name, responseBody) => {
    const result = await handleNonStreamingResponse(nonStreamingContext({
      providerResponse: jsonProviderResponse(responseBody),
    }));

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(await result.response.json()).toEqual(CLASSIFIER_ERROR);
  });

  it("rejects a legacy OpenAI Chat JSON function_call beside a classifier decision", async () => {
    const result = await handleNonStreamingResponse(nonStreamingContext({
      providerResponse: jsonProviderResponse(openAICompletionMessage({
        role: "assistant",
        content: "<block>no</block>",
        function_call: { name: "shell", arguments: "{\"cmd\":\"pwd\"}" },
      })),
    }));

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(await result.response.json()).toEqual(CLASSIFIER_ERROR);
  });

  it.each([
    ["missing content", { ...nativeClaudeMessage([]), content: undefined }],
    ["thinking only", nativeClaudeMessage([{ type: "thinking", thinking: "private" }])],
    ["malformed thinking", nativeClaudeMessage([{ type: "thinking", thinking: null }])],
    ["tool use", nativeClaudeMessage([{ type: "tool_use", id: "tool_1", name: "shell", input: {} }])],
    ["two text blocks", nativeClaudeMessage([{ type: "text", text: "<block>no</block>" }, { type: "text", text: "<block>yes</block>" }])],
    ["decision plus unknown block", nativeClaudeMessage([{ type: "text", text: "<block>no</block>" }, { type: "future_part" }])],
  ])("rejects invalid native Claude JSON with %s", async (_name, responseBody) => {
    const result = await handleNonStreamingResponse(nonStreamingContext({
      targetFormat: FORMATS.CLAUDE,
      provider: "claude",
      providerResponse: jsonProviderResponse(responseBody),
    }));

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(await result.response.json()).toEqual(CLASSIFIER_ERROR);
  });

  it.each([
    ["earlier prose then decision", [textItem("prose"), textItem("<block>no</block>")]],
    ["allow then deny", [textItem("<block>yes</block>"), textItem("<block>no</block>")]],
    ["deny then allow", [textItem("<block>no</block>"), textItem("<block>yes</block>")]],
    ["duplicate decisions", [textItem("<block>no</block>"), textItem("<block>no</block>")]],
    ["two text blocks", [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "<block>no</block>" }, { type: "output_text", text: "<block>yes</block>" }] }]],
    ["empty message then decision", [{ type: "message", role: "assistant", content: [] }, textItem("<block>no</block>")]],
    ["function call", [textItem("<block>no</block>"), { type: "function_call", id: "fc_hidden", name: "shell", arguments: "{}" }]],
    ["custom tool call", [textItem("<block>no</block>"), { type: "custom_tool_call", id: "ct_hidden", name: "shell", input: "pwd" }]],
    ["function call output", [textItem("<block>no</block>"), { type: "function_call_output", call_id: "fc_hidden", output: "done" }]],
    ["custom tool output", [textItem("<block>no</block>"), { type: "custom_tool_call_output", call_id: "ct_hidden", output: "done" }]],
    ["additional tools", [textItem("<block>no</block>"), { type: "additional_tools", tools: [] }]],
    ["unknown item", [textItem("<block>no</block>"), { type: "future_item" }]],
    ["unknown nested block", [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "<block>no</block>" }, { type: "future_part" }] }]],
    ["malformed reasoning", [{ type: "reasoning", summary: [{ type: "summary_text", text: null }] }, textItem("<block>no</block>")]],
    ["missing output", undefined],
    ["empty output", []],
    ["non-array output", "invalid"],
  ])("rejects invalid Responses JSON with %s", async (_name, output) => {
    const result = await handleNonStreamingResponse(nonStreamingContext({
      targetFormat: FORMATS.OPENAI_RESPONSES,
      provider: "codex",
      providerResponse: jsonProviderResponse(responsesJson(output)),
    }));

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(await result.response.json()).toEqual(CLASSIFIER_ERROR);
  });

  it.each([
    ["duplicate output index", (safeItem) => [
      doneFrame(safeItem, 0),
      doneFrame({ ...safeItem, id: "msg_classifier_duplicate" }, 0),
      terminalFrame(),
    ]],
    ["hidden custom tool", (safeItem) => [
      doneFrame(safeItem, 0),
      doneFrame({ id: "ct_hidden", type: "custom_tool_call", name: "shell", input: "pwd" }, 1),
      terminalFrame(),
    ]],
    ["terminal mismatch", (safeItem) => [
      doneFrame(safeItem, 0),
      terminalFrame([{ ...safeItem, content: [{ type: "output_text", text: "<block>yes</block>" }] }]),
    ]],
    ["EOF before terminal", (safeItem) => [doneFrame(safeItem, 0)]],
  ])("rejects invalid unexpected Responses SSE with %s", async (_name, makeChunks) => {
    const safeItem = { id: "msg_classifier_safe", ...textItem("<block>no</block>") };
    const result = await handleNonStreamingResponse(nonStreamingContext({
      targetFormat: FORMATS.OPENAI_RESPONSES,
      provider: "codex",
      providerResponse: new Response(readableFromChunks(makeChunks(safeItem)), {
        headers: { "content-type": "text/event-stream" },
      }),
    }));

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(await result.response.json()).toEqual(CLASSIFIER_ERROR);
  });

  it.each([
    ["prose", [{ delta: { content: "This looks safe to me." }, finish_reason: "stop" }]],
    ["two text segments with surrounding prose", [
      { delta: { content: "<block>no</block>" }, finish_reason: null },
      { delta: { content: " extra" }, finish_reason: "stop" },
    ]],
    ["decision plus tool use", [
      {
        delta: {
          content: "<block>no</block>",
          tool_calls: [{ index: 0, id: "call_hidden", function: { name: "shell", arguments: "{}" } }],
        },
        finish_reason: "tool_calls",
      },
    ]],
  ])("rejects invalid forced Chat SSE with %s", async (_name, choices) => {
    const chunks = choices.map((choice) => `data: ${JSON.stringify({
      id: "chatcmpl-classifier_1700000000",
      created: 1700000000,
      model: "gpt-5.6-sol",
      choices: [choice],
    })}\n\n`);
    chunks.push("data: [DONE]\n\n");
    const result = await handleForcedSSEToJson({
      ...forcedResponsesContext(STAGE_ONE_BODY, chunks),
      targetFormat: FORMATS.OPENAI,
      provider: "op-test-chat",
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(await result.response.json()).toEqual(CLASSIFIER_ERROR);
  });

  it.each([
    ["legacy function_call", {
      function_call: { name: "shell", arguments: "{\"cmd\":\"pwd\"}" },
    }],
    ["images", {
      images: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }],
    }],
    ["unknown delta fields", {
      future_action: { command: "pwd" },
    }],
  ])("rejects hidden forced Chat SSE %s beside a classifier decision", async (_name, extraDelta) => {
    const result = await handleForcedSSEToJson({
      ...forcedResponsesContext(STAGE_ONE_BODY, [
        `data: ${JSON.stringify({
          id: "chatcmpl_classifier_1700000000",
          created: 1700000000,
          model: "gpt-5.6-sol",
          choices: [{
            delta: { content: "<block>no</block>", ...extraDelta },
            finish_reason: "stop",
          }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ]),
      targetFormat: FORMATS.OPENAI,
      provider: "op-test-chat",
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(await result.response.json()).toEqual(CLASSIFIER_ERROR);
  });

  it("canonicalizes forced Chat SSE reasoning beside a decision", async () => {
    const result = await handleForcedSSEToJson({
      ...forcedResponsesContext(STAGE_ONE_BODY, [
        `data: ${JSON.stringify({
          id: "chatcmpl-classifier_1700000000",
          created: 1700000000,
          model: "gpt-5.6-sol",
          choices: [{
            delta: { reasoning_content: "private", content: "<block>no</block>" },
            finish_reason: "stop",
          }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ]),
      targetFormat: FORMATS.OPENAI,
      provider: "op-test-chat",
    });

    expect(result.success).toBe(true);
    expect(await result.response.json()).toMatchObject({
      id: "classifier_1700000000",
      type: "message",
      role: "assistant",
      model: "gpt-5.6-sol",
      content: [{ type: "text", text: "<block>no</block>" }],
      stop_reason: "end_turn",
      stop_sequence: null,
    });
  });

  it("rejects Gemini SSE with a function call beside a decision", async () => {
    const raw = [
      'data: {"response":{"responseId":"gemini_classifier","modelVersion":"gemini-3.7-flash-low","candidates":[{"content":{"parts":[{"text":"<block>no</block>"},{"functionCall":{"name":"shell","args":{"cmd":"pwd"}}}]},"finishReason":"STOP"}]}}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    const result = await handleForcedSSEToJson({
      ...forcedResponsesContext(STAGE_ONE_BODY, [raw]),
      targetFormat: FORMATS.GEMINI,
      provider: "gemini",
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(await result.response.json()).toEqual(CLASSIFIER_ERROR);
  });

  it.each([
    ["executableCode", { executableCode: { language: "SHELL", code: "pwd" } }],
    ["unknown actionable content", { future_action: { command: "pwd" } }],
  ])("rejects Gemini SSE %s beside a classifier decision", async (_name, extraPart) => {
    const raw = [
      `data: ${JSON.stringify({
        response: {
          responseId: "gemini_classifier",
          modelVersion: "gemini-3.7-flash-low",
          candidates: [{
            content: { parts: [{ text: "<block>no</block>", ...extraPart }] },
            finishReason: "STOP",
          }],
        },
      })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
    const result = await handleForcedSSEToJson({
      ...forcedResponsesContext(STAGE_ONE_BODY, [raw]),
      targetFormat: FORMATS.GEMINI,
      provider: "gemini",
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(await result.response.json()).toEqual(CLASSIFIER_ERROR);
  });

  it("rejects malformed classifier prose from forced Responses SSE", async () => {
    const context = forcedResponsesContext(STAGE_ONE_BODY, [
      doneFrame(textItem("This looks safe to me.")),
      terminalFrame(),
    ]);
    const result = await handleForcedSSEToJson(context);

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(await result.response.json()).toEqual(CLASSIFIER_ERROR);
    expect(context.onRequestSuccess).toHaveBeenCalledOnce();
    expect(context.appendLog).toHaveBeenCalledOnce();
    expect(context.appendLog).toHaveBeenCalledWith(expect.objectContaining({
      status: "200 OK",
    }));
  });

  it.each([
    [
      "an earlier prose message before a final decision",
      [
        doneFrame(textItem("This looks safe to me."), 0),
        doneFrame(textItem("<block>no</block>"), 1),
        terminalFrame(),
      ],
    ],
    [
      "a custom tool item dropped by conversion",
      [
        doneFrame(textItem("<block>no</block>"), 0),
        doneFrame({ type: "custom_tool_call", id: "ct_hidden", name: "shell", input: "pwd" }, 1),
        terminalFrame(),
      ],
    ],
    [
      "an unknown item dropped by conversion",
      [
        doneFrame(textItem("<block>yes</block>"), 0),
        doneFrame({ type: "future_item", id: "future_hidden" }, 1),
        terminalFrame(),
      ],
    ],
    [
      "an unknown message content block dropped by conversion",
      [
        doneFrame({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "<block>yes</block>" }, { type: "future_part" }],
        }, 0),
        terminalFrame(),
      ],
    ],
  ])("rejects raw Responses SSE ambiguity from %s", async (_name, chunks) => {
    const result = await handleForcedSSEToJson(
      forcedResponsesContext(STAGE_ONE_BODY, chunks),
    );

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(await result.response.json()).toEqual(CLASSIFIER_ERROR);
  });

  it("rejects actionable output hidden in recognized metadata", async () => {
    const safeItem = {
      id: "msg_classifier_safe",
      ...textItem("<block>no</block>"),
    };
    const result = await handleForcedSSEToJson(
      forcedResponsesContext(STAGE_ONE_BODY, [
        frame("response.created", {
          type: "response.created",
          response: {
            id: "resp_classifier_1700000000",
            output: [{ id: "ct_hidden", type: "custom_tool_call", name: "shell", input: "pwd" }],
          },
        }),
        doneFrame(safeItem),
        terminalFrame([safeItem]),
      ]),
    );

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(await result.response.json()).toEqual(CLASSIFIER_ERROR);
  });

  it.each([
    ["explicit event", (data) => frame("response.created", data)],
    ["data-only JSON type", (data) => `data: ${JSON.stringify(data)}\n\n`],
  ])("accepts empty response.output metadata from %s", async (_name, metadataFrame) => {
    const safeItem = {
      id: "msg_classifier_safe",
      ...textItem("<block>no</block>"),
    };
    const result = await handleForcedSSEToJson(
      forcedResponsesContext(STAGE_ONE_BODY, [
        metadataFrame({
          type: "response.created",
          response: { id: "resp_classifier_1700000000", output: [] },
        }),
        doneFrame(safeItem),
        terminalFrame([safeItem]),
      ]),
    );

    expect(result.success).toBe(true);
    expect(await result.response.json()).toMatchObject({
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "<block>no</block>" }],
    });
  });

  it("rejects a blank explicit SSE event instead of falling back to JSON type", async () => {
    const safeItem = {
      id: "msg_classifier_safe",
      ...textItem("<block>no</block>"),
    };
    const blankEventTerminal = `event:\ndata: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_classifier_1700000000",
        status: "completed",
        output: [safeItem],
        usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
      },
    })}\n\n`;
    const result = await handleForcedSSEToJson(
      forcedResponsesContext(STAGE_ONE_BODY, [
        doneFrame(safeItem),
        blankEventTerminal,
      ]),
    );

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(await result.response.json()).toEqual(CLASSIFIER_ERROR);
  });

  it.each([
    [
      "an added custom-tool item without an authoritative terminal item",
      frame("response.output_item.added", {
        type: "response.output_item.added",
        output_index: 1,
        item: { id: "ct_hidden", type: "custom_tool_call", name: "shell", input: "pwd" },
      }),
    ],
    [
      "an added unknown content part without an authoritative terminal block",
      frame("response.content_part.added", {
        type: "response.content_part.added",
        output_index: 0,
        item_id: "msg_classifier_safe",
        content_index: 1,
        part: { type: "unknown_part" },
      }),
    ],
    [
      "a function-call argument fragment without an authoritative call",
      frame("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        output_index: 1,
        item_id: "fc_hidden",
        delta: "{\"cmd\":\"pwd\"}",
      }),
    ],
    [
      "a custom-tool input fragment without an authoritative custom tool",
      frame("response.custom_tool_call_input.delta", {
        type: "response.custom_tool_call_input.delta",
        output_index: 1,
        item_id: "ct_hidden",
        delta: "pwd",
      }),
    ],
    [
      "an output-text fragment with a conflicting item identity",
      frame("response.output_text.delta", {
        type: "response.output_text.delta",
        output_index: 0,
        item_id: "msg_wrong",
        content_index: 0,
        delta: "<block>yes</block>",
      }),
    ],
  ])("rejects unresolved Responses transport evidence from %s", async (_name, fragment) => {
    const safeItem = {
      id: "msg_classifier_safe",
      ...textItem("<block>no</block>"),
    };
    const result = await handleForcedSSEToJson(
      forcedResponsesContext(STAGE_ONE_BODY, [
        fragment,
        terminalFrame([safeItem]),
      ]),
    );

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(await result.response.json()).toEqual(CLASSIFIER_ERROR);
  });

  it("keeps a non-Claude OpenAI JSON near miss unchanged without classifier calls", async () => {
    const result = await runWithoutClassifierCalls(() => handleNonStreamingResponse(
      nonStreamingContext({
        sourceFormat: FORMATS.OPENAI,
        providerResponse: jsonProviderResponse(openAICompletion("ordinary prose")),
      }),
    ));

    expect(result.success).toBe(true);
    expect(await result.response.json()).toEqual({
      ...openAICompletion("ordinary prose"),
      model: "subscription",
      usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
    });
  });

  it("keeps a non-Claude forced Chat SSE near miss unchanged without classifier calls", async () => {
    const result = await runWithoutClassifierCalls(() => handleForcedSSEToJson({
      ...forcedResponsesContext(STAGE_ONE_BODY, [
        `data: ${JSON.stringify({
          id: "chatcmpl_nonclaude_forced",
          created: 1700000000,
          model: "gpt-5.6-sol",
          choices: [{ delta: { content: "ordinary forced prose" }, finish_reason: "stop" }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ], {
        sourceFormat: FORMATS.OPENAI,
        targetFormat: FORMATS.OPENAI,
        provider: "op-test-chat",
      }),
    }));

    expect(result.success).toBe(true);
    expect(await result.response.json()).toEqual({
      id: "chatcmpl_nonclaude_forced",
      object: "chat.completion",
      created: 1700000000,
      model: "gpt-5.6-sol",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "ordinary forced prose" },
        finish_reason: "stop",
      }],
    });
  });

  it("keeps a non-Claude Responses JSON near miss unchanged without classifier calls", async () => {
    const result = await runWithoutClassifierCalls(() => handleNonStreamingResponse(
      nonStreamingContext({
        sourceFormat: FORMATS.OPENAI,
        targetFormat: FORMATS.OPENAI_RESPONSES,
        provider: "codex",
        providerResponse: jsonProviderResponse(responsesJson([
          { id: "msg_nonclaude", ...textItem("ordinary Responses prose") },
        ], { id: "resp_nonclaude_json" })),
      }),
    ));

    expect(result.success).toBe(true);
    expect(await result.response.json()).toEqual({
      id: "chatcmpl-nonclaude_json",
      object: "chat.completion",
      created: 1700000000,
      model: "subscription",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "ordinary Responses prose" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
    });
  });

  it("keeps a non-Claude native Claude JSON near miss unchanged without classifier calls", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1700000000000));
    try {
      const result = await runWithoutClassifierCalls(() => handleNonStreamingResponse(
        nonStreamingContext({
          sourceFormat: FORMATS.OPENAI,
          targetFormat: FORMATS.CLAUDE,
          provider: "claude",
          providerResponse: jsonProviderResponse(nativeClaudeMessage([
            { type: "text", text: "ordinary native prose" },
          ])),
        }),
      ));

      expect(result.success).toBe(true);
      expect(await result.response.json()).toEqual({
        id: "chatcmpl-msg_classifier_1700000000",
        object: "chat.completion",
        created: 1700000000,
        model: "subscription",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "ordinary native prose" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a non-Claude unexpected Responses SSE near miss unchanged without classifier calls", async () => {
    const ordinaryItem = { id: "msg_nonclaude_sse", ...textItem("ordinary Responses SSE prose") };
    const stream = readableFromChunks([
      frame("response.created", {
        type: "response.created",
        response: { id: "resp_nonclaude_sse", created_at: 1700000000 },
      }),
      doneFrame(ordinaryItem),
      terminalFrame([ordinaryItem]),
    ]);
    const tee = vi.spyOn(stream, "tee");
    try {
      const result = await runWithoutClassifierCalls(() => handleNonStreamingResponse(
        nonStreamingContext({
          sourceFormat: FORMATS.OPENAI,
          targetFormat: FORMATS.OPENAI_RESPONSES,
          provider: "codex",
          providerResponse: new Response(stream, { headers: { "content-type": "text/event-stream" } }),
        }),
      ));

      expect(result.success).toBe(true);
      expect(tee).not.toHaveBeenCalled();
      expect(await result.response.json()).toEqual({
        id: "chatcmpl-nonclaude_sse",
        object: "chat.completion",
        created: 1700000000,
        model: "subscription",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "ordinary Responses SSE prose" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
      });
    } finally {
      tee.mockRestore();
    }
  });

  it("keeps an ordinary Claude Responses SSE unprojected and unteed", async () => {
    const ordinaryBody = deepFreeze({ ...STAGE_ONE_BODY, system: "ordinary request" });
    const ordinaryItem = { id: "msg_ordinary_sse", ...textItem("ordinary Claude prose") };
    const stream = readableFromChunks([
      frame("response.created", {
        type: "response.created",
        response: { id: "resp_ordinary_sse", created_at: 1700000000 },
      }),
      doneFrame(ordinaryItem),
      terminalFrame([ordinaryItem]),
    ]);
    const tee = vi.spyOn(stream, "tee");
    const spies = classifierCallSpies();
    try {
      const result = await handleNonStreamingResponse(nonStreamingContext({
        body: ordinaryBody,
        targetFormat: FORMATS.OPENAI_RESPONSES,
        provider: "codex",
        providerResponse: new Response(stream, { headers: { "content-type": "text/event-stream" } }),
      }));

      expect(result.success).toBe(true);
      expect(spies.detect).toHaveBeenCalledOnce();
      expect(spies.output).not.toHaveBeenCalled();
      expect(spies.stream).not.toHaveBeenCalled();
      expect(spies.validate).not.toHaveBeenCalled();
      expect(tee).not.toHaveBeenCalled();
      expect(await result.response.json()).toEqual({
        id: "ordinary_sse",
        type: "message",
        role: "assistant",
        model: "subscription",
        content: [{ type: "text", text: "ordinary Claude prose" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 2 },
      });
    } finally {
      restoreClassifierSpies(spies);
      tee.mockRestore();
    }
  });

  it("keeps a non-Claude Gemini SSE near miss unchanged without classifier calls", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1700000000000));
    try {
      const raw = [
        'data: {"response":{"responseId":"gemini_nonclaude","modelVersion":"gemini-3.7-flash-low","usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":2,"totalTokenCount":10},"candidates":[{"content":{"parts":[{"text":"ordinary Gemini prose"}]},"finishReason":"STOP"}]}}',
        "data: [DONE]",
        "",
      ].join("\n\n");
      const result = await runWithoutClassifierCalls(() => handleForcedSSEToJson({
        ...forcedResponsesContext(STAGE_ONE_BODY, [raw], {
          sourceFormat: FORMATS.OPENAI,
          targetFormat: FORMATS.GEMINI,
          provider: "gemini",
        }),
      }));

      expect(result.success).toBe(true);
      expect(await result.response.json()).toEqual({
        id: "resp_gemini_nonclaude",
        object: "chat.completion",
        created: 1700000000,
        model: "gemini-3.7-flash-low",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "ordinary Gemini prose" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves ordinary Responses reasoning and custom tool conversion", async () => {
    const ordinaryBody = deepFreeze({ ...STAGE_ONE_BODY, system: "ordinary request" });
    const result = await handleNonStreamingResponse(nonStreamingContext({
      body: ordinaryBody,
      targetFormat: FORMATS.OPENAI_RESPONSES,
      provider: "codex",
      providerResponse: jsonProviderResponse(responsesJson([
        {
          id: "rs_ordinary",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "ordinary reasoning" }],
        },
        { id: "msg_ordinary", ...textItem("ordinary Responses text") },
        { id: "ct_ordinary", type: "custom_tool_call", name: "shell", input: "pwd" },
      ], { id: "resp_ordinary_rich" })),
    }));

    expect(result.success).toBe(true);
    expect(await result.response.json()).toEqual({
      id: "ordinary_rich",
      type: "message",
      role: "assistant",
      model: "subscription",
      content: [
        { type: "thinking", thinking: "ordinary reasoning" },
        { type: "text", text: "ordinary Responses text" },
        { type: "tool_use", id: "ct_ordinary", name: "shell", input: { input: "pwd" } },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 8, output_tokens: 2 },
    });
  });

  it("keeps ordinary forced Responses incomplete status cache-aware without teeing", async () => {
    const ordinaryBody = deepFreeze({ ...STAGE_ONE_BODY, system: "ordinary request" });
    const item = { id: "msg_ordinary_incomplete", ...textItem("ordinary incomplete text") };
    const stream = readableFromChunks([
      frame("response.created", {
        type: "response.created",
        response: { id: "resp_ordinary_incomplete", created_at: 1700000000 },
      }),
      doneFrame(item),
      frame("response.incomplete", {
        type: "response.incomplete",
        response: {
          id: "resp_ordinary_incomplete",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: {
            input_tokens: 8,
            output_tokens: 2,
            total_tokens: 10,
            input_tokens_details: { cached_tokens: 12 },
          },
        },
      }),
    ]);
    const tee = vi.spyOn(stream, "tee");
    const spies = classifierCallSpies();
    try {
      const context = {
        ...forcedResponsesContext(ordinaryBody, [], {
          targetFormat: FORMATS.OPENAI_RESPONSES,
          provider: "codex",
        }),
        providerResponse: new Response(stream, { headers: { "content-type": "text/event-stream" } }),
      };
      const result = await handleForcedSSEToJson(context);

      expect(result.success).toBe(true);
      expect(spies.detect).toHaveBeenCalledOnce();
      expect(spies.stream).not.toHaveBeenCalled();
      expect(spies.output).not.toHaveBeenCalled();
      expect(spies.validate).not.toHaveBeenCalled();
      expect(tee).not.toHaveBeenCalled();
      expect(context.appendLog).toHaveBeenCalledWith(expect.objectContaining({
        status: "200 OK",
        tokens: expect.objectContaining({
          input_tokens_details: { cached_tokens: 12 },
        }),
      }));
      expect(await result.response.json()).toEqual({
        id: "ordinary_incomplete",
        type: "message",
        role: "assistant",
        model: "gpt-5.6-sol",
        content: [{ type: "text", text: "ordinary incomplete text" }],
        stop_reason: "max_tokens",
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 2 },
      });
    } finally {
      restoreClassifierSpies(spies);
      tee.mockRestore();
    }
  });

  it("preserves ordinary Chat reasoning when no text is present", async () => {
    const ordinaryBody = deepFreeze({ ...STAGE_ONE_BODY, system: "ordinary request" });
    const result = await handleNonStreamingResponse(nonStreamingContext({
      body: ordinaryBody,
      providerResponse: jsonProviderResponse(openAICompletionMessage({
        role: "assistant",
        content: "",
        reasoning_content: "ordinary Chat reasoning",
      })),
    }));

    expect(result.success).toBe(true);
    expect(await result.response.json()).toEqual({
      id: "chatcmpl_classifier_1700000000",
      type: "message",
      role: "assistant",
      model: "subscription",
      content: [{ type: "thinking", thinking: "ordinary Chat reasoning" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 8, output_tokens: 2 },
    });
  });

  it("preserves ordinary JSON fence removal and empty-content fallback", async () => {
    const jsonBody = deepFreeze({
      ...STAGE_ONE_BODY,
      system: "ordinary request",
      response_format: { type: "json_object" },
    });
    const fenced = await handleNonStreamingResponse(nonStreamingContext({
      body: jsonBody,
      sourceFormat: FORMATS.OPENAI,
      providerResponse: jsonProviderResponse(openAICompletion("```json\n{\"ok\":true}\n```")),
    }));
    const empty = await handleNonStreamingResponse(nonStreamingContext({
      body: deepFreeze({ ...STAGE_ONE_BODY, system: "ordinary request" }),
      providerResponse: jsonProviderResponse(openAICompletion("")),
    }));

    expect(fenced.success).toBe(true);
    expect(await fenced.response.json()).toMatchObject({
      object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "{\"ok\":true}" } }],
      model: "subscription",
    });
    expect(empty.success).toBe(false);
    expect(empty.status).toBe(502);
    expect(await empty.response.json()).toMatchObject({
      error: { message: "Empty response content from op-test-chat/gpt-5.6-sol" },
    });
  });
});

describe("Task 3 caller-abort terminality", () => {
  it("returns a 499 core Response without account mutation", async () => {
    vi.useFakeTimers();
    const abortResponse = new Response("Request aborted", { status: 499 });
    const coreResult = {
      success: false,
      status: 499,
      error: "Request aborted",
      response: abortResponse,
    };
    const { handleChat, mocks } = await loadTerminalChatHandler({ coreResult });

    try {
      const response = await handleChat(terminalChatRequest());

      expect(response).toBe(abortResponse);
      expect(response.status).toBe(499);
      expect(await response.text()).toBe("Request aborted");
      expect(mocks.handleChatCore).toHaveBeenCalledOnce();
      expect(mocks.getProviderCredentials).toHaveBeenCalledOnce();
      expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
      expect(mocks.clearAccountError).not.toHaveBeenCalled();
      expect(mocks.updateProviderCredentials).not.toHaveBeenCalled();
      expect(mocks.appendPxpipeEvent).not.toHaveBeenCalled();
      expect(mocks.appendTokenSaverEvent).not.toHaveBeenCalled();
      expect(mocks.checkAndRefreshToken).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      unloadChatHandler();
    }
  });

  it("keeps a 502 core Response on the existing account fallback path", async () => {
    const failureResponse = new Response("Classifier rejected", { status: 502 });
    const coreResult = {
      success: false,
      status: 502,
      error: "Classifier rejected",
      response: failureResponse,
    };
    const { handleChat, mocks } = await loadTerminalChatHandler({
      coreResult,
      shouldFallback: false,
    });

    try {
      const response = await handleChat(terminalChatRequest());

      expect(response.headers.get("x-tokenproxy-replay-safe")).toBe("false");
      expect(response.status).toBe(502);
      expect(await response.text()).toBe("Classifier rejected");
      expect(mocks.handleChatCore).toHaveBeenCalledOnce();
      expect(mocks.getProviderCredentials).toHaveBeenCalledOnce();
      expect(mocks.markAccountUnavailable).toHaveBeenCalledOnce();
      expect(mocks.clearAccountError).not.toHaveBeenCalled();
      expect(mocks.updateProviderCredentials).not.toHaveBeenCalled();
    } finally {
      unloadChatHandler();
    }
  });
});

const malformedClassifierHandlerResponse = async () => {
  const result = await handleForcedSSEToJson({
    ...forcedResponsesContext(STAGE_ONE_BODY, [
      `data: ${JSON.stringify({
        id: "chatcmpl_classifier_1700000000",
        model: "gpt-5.6-sol",
        choices: [{ delta: { content: "This looks safe to me." }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: "chatcmpl_classifier_1700000000",
        model: "gpt-5.6-sol",
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ]),
    targetFormat: FORMATS.OPENAI,
    provider: "op-test-chat",
  });

  expect(result.success).toBe(false);
  expect(result.status).toBe(502);
  return result.response;
};

const canonicalClassifierHandlerResponse = async () => {
  const result = await handleForcedSSEToJson({
    ...forcedResponsesContext(STAGE_ONE_BODY, [
      `data: ${JSON.stringify({
        id: "chatcmpl_classifier_1700000000",
        model: "gpt-5.6-sol",
        choices: [{ delta: { content: "<block>no</block>" }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: "chatcmpl_classifier_1700000000",
        model: "gpt-5.6-sol",
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ]),
    targetFormat: FORMATS.OPENAI,
    provider: "op-test-chat",
  });

  expect(result.success).toBe(true);
  return result.response;
};

describe("Task 3 combo classifier terminality", () => {
  it("returns an accepted malformed classifier result without generating on a different model", async () => {
    const malformed = await malformedClassifierHandlerResponse();
    const canonical = await canonicalClassifierHandlerResponse();
    const handleSingleModel = vi.fn(async (_body, model) => (
      model === "cx/gpt-5.6-sol" ? malformed : canonical
    ));
    vi.useFakeTimers();
    resetComboRotation();

    try {
      const pending = handleComboChat({
        body: STAGE_ONE_BODY,
        models: ["cx/gpt-5.6-sol", "cc/claude-opus-4-8"],
        handleSingleModel,
        log: { info: vi.fn(), warn: vi.fn() },
        comboName: "subscription",
        comboStrategy: "fallback",
      });
      await vi.advanceTimersByTimeAsync(5000);
      const response = await pending;

      expect(response.status).toBe(502);
      expect(handleSingleModel).toHaveBeenCalledTimes(1);
      expect(handleSingleModel.mock.calls[0][1]).toBe("cx/gpt-5.6-sol");
      expect(response.headers.get("x-tokenproxy-replay-safe")).not.toBe("true");
    } finally {
      vi.useRealTimers();
      resetComboRotation();
    }
  });

  it("returns a first canonical decision without scheduling a fallback", async () => {
    const canonical = await canonicalClassifierHandlerResponse();
    const handleSingleModel = vi.fn(async () => canonical);
    vi.useFakeTimers();
    resetComboRotation();

    try {
      const response = await handleComboChat({
        body: STAGE_ONE_BODY,
        models: ["cx/gpt-5.6-sol", "cc/claude-opus-4-8"],
        handleSingleModel,
        log: { info: vi.fn(), warn: vi.fn() },
        comboName: "subscription",
        comboStrategy: "fallback",
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("x-tokenproxy-model")).toBe("cx/gpt-5.6-sol");
      expect(handleSingleModel).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      resetComboRotation();
    }
  });

  it("returns a first 499 Response without scheduling a fallback", async () => {
    const abortResponse = new Response("Request aborted", { status: 499 });
    const handleSingleModel = vi.fn(async () => abortResponse);
    vi.useFakeTimers();
    resetComboRotation();

    try {
      const response = await handleComboChat({
        body: STAGE_ONE_BODY,
        models: ["cx/gpt-5.6-sol", "cc/claude-opus-4-8"],
        handleSingleModel,
        log: { info: vi.fn(), warn: vi.fn() },
        comboName: "subscription",
        comboStrategy: "fallback",
      });

      expect(response).toBe(abortResponse);
      expect(response.headers.get("x-tokenproxy-combo")).toBeNull();
      expect(handleSingleModel).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      resetComboRotation();
    }
  });

  it.each([401, 429, 503, 504])(
    "keeps classifier-adjacent %i errors distinct from a decision",
    async (status) => {
      const handleSingleModel = vi.fn(async () => new Response(
        JSON.stringify({ error: { message: `upstream ${status}` } }),
        { status, headers: { "content-type": "application/json" } },
      ));
      vi.useFakeTimers();
      resetComboRotation();

      try {
        const pending = handleComboChat({
          body: STAGE_ONE_BODY,
          models: ["cx/gpt-5.6-sol"],
          handleSingleModel,
          log: { info: vi.fn(), warn: vi.fn() },
          comboName: "subscription",
          comboStrategy: "fallback",
        });
        await vi.advanceTimersByTimeAsync(5000);
        const response = await pending;

        expect(response.status).toBe(status);
        expect(await response.text()).not.toContain("<block>");
        expect(handleSingleModel).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
        resetComboRotation();
      }
    },
  );
});

const CHAT_CORE_EXECUTOR_MODULE = "../../open-sse/executors/index.js";
const unloadFastTierChatCore = () => {
  vi.doUnmock(CHAT_CORE_EXECUTOR_MODULE);
  vi.resetModules();
};
const malformedResponsesSse = () => new Response(readableFromChunks([
  doneFrame({
    id: "msg_classifier_malformed",
    ...textItem("This looks safe to me."),
  }),
  terminalFrame([{
    id: "msg_classifier_malformed",
    ...textItem("This looks safe to me."),
  }]),
]), { headers: { "content-type": "text/event-stream" } });
async function loadFastTierChatCore() {
  const execute = vi.fn(async () => ({
    response: malformedResponsesSse(),
    url: "https://upstream.test/responses",
    headers: {},
    transformedBody: {},
  }));
  const getExecutor = vi.fn(() => ({
    execute,
    refreshCredentials: vi.fn(),
    noAuth: false,
  }));

  vi.resetModules();
  vi.doMock(CHAT_CORE_EXECUTOR_MODULE, () => ({ getExecutor }));
  const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
  return { execute, handleChatCore };
}
const fastTierCoreOptions = (body, codexFastMode) => ({
  body,
  modelInfo: { provider: "codex", model: "gpt-5.6-sol" },
  credentials: { apiKey: "provider-key", providerSpecificData: {} },
  clientRawRequest: {
    endpoint: "/v1/messages",
    body,
    headers: { accept: "application/json" },
  },
  connectionId: "classifier-fast-tier",
  sourceFormatOverride: FORMATS.CLAUDE,
  codexFastMode,
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
});

describe("Task 3 Codex Fast tier before classifier validation", () => {
  it.each([
    ["absent", undefined, "priority"],
    ["default", "default", "default"],
    ["priority", "priority", "priority"],
  ])(
    "keeps client service tier %s at %s through the real classifier 502 path",
    async (_name, clientServiceTier, expectedTier) => {
      const body = {
        ...structuredClone(STAGE_ONE_BODY),
        ...(clientServiceTier === undefined ? {} : { service_tier: clientServiceTier }),
      };
      const { execute, handleChatCore } = await loadFastTierChatCore();

      try {
        const result = await handleChatCore(fastTierCoreOptions(body, true));

        expect(execute).toHaveBeenCalledOnce();
        expect(execute.mock.calls[0][0].body.service_tier).toBe(expectedTier);
        expect(result.success).toBe(false);
        expect(result.status).toBe(502);
        expect(await result.response.json()).toEqual(CLASSIFIER_ERROR);
      } finally {
        unloadFastTierChatCore();
      }
    },
  );
});

describe("Task 3 classifier request and model invariants", () => {
  it.each([
    ["windsurf", "claude-sonnet-4.6-thinking-1m"],
    ["windsurf", "claude-sonnet-4.6-1m"],
    ["devin-cli", "claude-sonnet-4.6-thinking-1m"],
  ])("preserves real %s model %s", (provider, model) => {
    expect(getModelUpstreamId(provider, model)).toBe(model);
  });

  it("keeps frozen classifier request fields and canonical Message metadata", () => {
    const body = deepFreeze({
      ...structuredClone(STAGE_ONE_BODY),
      model: "claude-sonnet-4.6-thinking-1m",
      service_tier: "priority",
      tools: [{ name: "shell", input_schema: { type: "object" } }],
    });
    const bodyBefore = structuredClone(body);
    const message = deepFreeze({
      ...claudeMessage([
        { type: "thinking", thinking: "private" },
        { type: "text", text: "<block>no</block>" },
      ]),
      id: "msg_classifier_invariant",
      model: "claude-sonnet-4.6-thinking-1m",
      stop_reason: "max_tokens",
      stop_sequence: "</block>",
      usage: { input_tokens: 13, output_tokens: 7 },
      extension: { retained: true, source: "provider" },
    });
    const messageBefore = structuredClone(message);

    const result = validateClaudeClassifierMessage(body, message);

    expect(body).toEqual(bodyBefore);
    expect(message).toEqual(messageBefore);
    expect(result).toEqual({
      ...messageBefore,
      content: [{ type: "text", text: "<block>no</block>" }],
    });
  });

  it("keeps a frozen classifier handler request byte-equal after a decision", async () => {
    const body = deepFreeze({
      ...structuredClone(STAGE_ONE_BODY),
      model: "claude-sonnet-4.6-thinking-1m",
      service_tier: "priority",
      tools: [{ name: "shell", input_schema: { type: "object" } }],
    });
    const before = structuredClone(body);
    const result = await handleForcedSSEToJson({
      ...forcedResponsesContext(body, [
        `data: ${JSON.stringify({
          id: "chatcmpl_classifier_invariant",
          model: "gpt-5.6-sol",
          choices: [{ delta: { content: "<block>no</block>" }, finish_reason: null }],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "chatcmpl_classifier_invariant",
          model: "gpt-5.6-sol",
          choices: [{ delta: {}, finish_reason: "stop" }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ]),
      targetFormat: FORMATS.OPENAI,
      provider: "op-test-chat",
    });

    expect(result.success).toBe(true);
    expect(body).toEqual(before);
  });
});

const safeClassifierChatChoice = {
  index: 0,
  message: { role: "assistant", content: "<block>no</block>" },
  finish_reason: "stop",
};
const safeClassifierChatDelta = {
  index: 0,
  delta: { content: "<block>no</block>" },
  finish_reason: "stop",
};
const safeClassifierGeminiCandidate = {
  content: { parts: [{ text: "<block>no</block>" }] },
  finishReason: "STOP",
};

describe("classifier alternatives remain fail-closed", () => {
  it.each([
    ["tool call", {
      index: 1,
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_hidden",
          type: "function",
          function: { name: "shell", arguments: "{\"cmd\":\"pwd\"}" },
        }],
      },
      finish_reason: "tool_calls",
    }],
    ["unknown choice field", {
      index: 1,
      message: { role: "assistant", content: "ordinary prose" },
      finish_reason: "stop",
      future_action: { command: "pwd" },
    }],
    ["malformed choice", null],
  ])("rejects hidden OpenAI Chat JSON choice 1 with %s", async (_name, hiddenChoice) => {
    const responseBody = openAICompletion("<block>no</block>");
    responseBody.choices = [safeClassifierChatChoice, hiddenChoice];
    const result = await handleNonStreamingResponse(nonStreamingContext({
      providerResponse: jsonProviderResponse(responseBody),
    }));

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(await result.response.json()).toEqual(CLASSIFIER_ERROR);
  });

  it.each([
    ["tool call", {
      index: 1,
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_hidden",
          function: { name: "shell", arguments: "{}" },
        }],
      },
      finish_reason: "tool_calls",
    }],
    ["unknown choice field", {
      index: 1,
      delta: { content: "ordinary prose" },
      finish_reason: "stop",
      future_action: { command: "pwd" },
    }],
    ["malformed choice", null],
  ])("rejects hidden forced Chat SSE choice 1 with %s", async (_name, hiddenChoice) => {
    const result = await handleForcedSSEToJson({
      ...forcedResponsesContext(STAGE_ONE_BODY, [
        `data: ${JSON.stringify({
          id: "chatcmpl_classifier_alternatives",
          model: "gpt-5.6-sol",
          choices: [safeClassifierChatDelta, hiddenChoice],
        })}\n\n`,
        "data: [DONE]\n\n",
      ]),
      targetFormat: FORMATS.OPENAI,
      provider: "op-test-chat",
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(await result.response.json()).toEqual(CLASSIFIER_ERROR);
  });

  it("rejects a hidden forced Gemini SSE candidate 1 contradiction", async () => {
    const raw = [
      `data: ${JSON.stringify({
        response: {
          responseId: "gemini_classifier_alternatives",
          modelVersion: "gemini-3.7-flash-low",
          candidates: [
            safeClassifierGeminiCandidate,
            {
              content: { parts: [{ text: "<block>yes</block>" }] },
              finishReason: "STOP",
            },
          ],
        },
      })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
    const result = await handleForcedSSEToJson({
      ...forcedResponsesContext(STAGE_ONE_BODY, [raw]),
      targetFormat: FORMATS.GEMINI,
      provider: "gemini",
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(await result.response.json()).toEqual(CLASSIFIER_ERROR);
  });

  it("rejects a hidden Gemini JSON candidate 1 contradiction", async () => {
    const result = await handleNonStreamingResponse(nonStreamingContext({
      targetFormat: FORMATS.GEMINI,
      provider: "gemini",
      providerResponse: jsonProviderResponse({
        responseId: "gemini_classifier_json_alternatives",
        modelVersion: "gemini-3.7-flash-low",
        candidates: [
          safeClassifierGeminiCandidate,
          {
            content: { parts: [{ text: "<block>yes</block>" }] },
            finishReason: "STOP",
          },
        ],
      }),
    }));

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(await result.response.json()).toEqual(CLASSIFIER_ERROR);
  });
});
