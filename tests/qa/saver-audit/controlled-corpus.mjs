import { readFileSync } from "node:fs";
import { buildSession, turnBodies } from "./fixture.mjs";
import { CHARS_PER_TOKEN, estimateChars, estimateRequestTokens } from "../../../open-sse/services/memory/contextBudget.js";

const definitionPath = new URL("../../fixtures/capabilities/savers/corpus.json", import.meta.url);
export const CONTROLLED_CORPUS = Object.freeze(JSON.parse(readFileSync(definitionPath, "utf8")));

const PAD_ROW = "fixture-row path=src/pipeline.js status=ok latency_ms=7 checksum=0123456789abcdef\n";

function requestChars(body) {
  const parts = [body.system, body.instructions, body.tools, body.systemInstruction];
  return parts.reduce((total, part) => total + estimateChars(part), 0)
    + estimateChars(Array.isArray(body.messages) ? body.messages : []);
}

function padding(length) {
  if (length <= 0) return "";
  return PAD_ROW.repeat(Math.ceil(length / PAD_ROW.length)).slice(0, length);
}

function oldestTextToolResult(body) {
  for (const message of body.messages || []) {
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type !== "tool_result") continue;
      const text = Array.isArray(block.content)
        ? block.content.find((part) => part?.type === "text" && typeof part.text === "string")
        : null;
      if (text) return text;
    }
  }
  throw new Error("controlled corpus requires a textual tool result");
}

export function buildControlledBody(population) {
  const spec = typeof population === "string"
    ? CONTROLLED_CORPUS.populations.find(({ id }) => id === population)
    : population;
  if (!spec) throw new Error(`unknown controlled corpus population ${population}`);
  const session = buildSession({ seed: spec.seed, rounds: 8, toolCount: 16, thinking: true });
  const body = turnBodies(session, {
    model: CONTROLLED_CORPUS.model,
    maxTokens: CONTROLLED_CORPUS.outputTokens,
  }).at(-1).body;
  body.output_config = { effort: CONTROLLED_CORPUS.effort };

  const targetChars = Math.floor((spec.estimatedContextTokens - 0.5) * CHARS_PER_TOKEN);
  const target = oldestTextToolResult(body);
  target.text += "\n[controlled-corpus-padding]\n";
  const needed = targetChars - requestChars(body);
  if (needed < 0) throw new Error(`${spec.id} base fixture exceeds target`);
  target.text += padding(needed);

  const observed = estimateRequestTokens(body);
  if (observed !== spec.estimatedContextTokens) {
    throw new Error(`${spec.id} expected ${spec.estimatedContextTokens} tokens, observed ${observed}`);
  }
  return body;
}

export function growControlledBody(body) {
  const next = structuredClone(body);
  const priorLive = next.messages.at(-1);
  if (Array.isArray(priorLive?.content)) {
    for (const block of priorLive.content) {
      if (block && typeof block === "object") delete block.cache_control;
    }
  }
  next.messages.push(
    { role: "assistant", content: [{ type: "text", text: "Controlled previous answer." }] },
    { role: "user", content: [{ type: "text", text: "Controlled next request.", cache_control: { type: "ephemeral" } }] },
  );
  return next;
}
