import {describe,it,expect} from "vitest";
import {canonicalizeUsage,extractUsage} from "../../open-sse/utils/usageTracking.js";
import {doneFields,extractUsageFromResponse} from "../../open-sse/handlers/chatCore/requestDetail.js";
describe("context usage provenance",()=>{
 it("never adds a cache-inclusive input count twice to calibration",()=>{
  expect(doneFields({usage:{prompt_tokens:1000,completion_tokens:2,cached_tokens:800}}).ctx).toBe(1000);
  expect(doneFields({usage:{input_tokens:100,output_tokens:2,cache_read_input_tokens:800,cache_creation_input_tokens:100}}).ctx).toBe(1000);
  expect(doneFields({usage:{prompt_tokens:1000,estimated:true}}).ctx).toBeUndefined();
 });
 it("retains estimate provenance and preserves observed zero cache",()=>{
  expect(canonicalizeUsage({prompt_tokens:1,estimated:true}).estimated).toBe(true);
  const u=extractUsage({usage:{prompt_tokens:10,prompt_tokens_details:{cached_tokens:0}}});
  expect(u.cached_tokens).toBe(0);expect(u.completion_tokens).toBeUndefined();
 });
 it("keeps absent output and cache fields absent across partial provider responses",()=>{
  const partial=extractUsage({type:"message_delta",usage:{output_tokens:2}});
  expect(partial.prompt_tokens).toBeUndefined();
  const gemini=extractUsageFromResponse({usageMetadata:{promptTokenCount:5}});
  expect(gemini.completion_tokens).toBeUndefined();expect(gemini.cached_tokens).toBeUndefined();
 });
});
