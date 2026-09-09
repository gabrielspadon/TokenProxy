'use strict';
const KIND = 'compatibility-gateway-v1';
function validateMarker(value, owner) {
  if (!value || value.kind !== KIND || value.runId !== owner.runId || value.root !== owner.root || Object.keys(value).sort().join(',') !== 'kind,root,runId') throw new Error('Invalid controlled compatibility gateway marker');
  return true;
}
function createPreviewTransport(counters, denied) {
  return async (url, options = {}) => {
    let body;
    try { body = JSON.parse(options.body); } catch { throw denied('outboundBlocked'); }
    const headers = new Headers(options.headers);
    if (String(url) !== 'https://api.openai.com/v1/chat/completions' || options.method !== 'POST' || headers.has('authorization') || headers.has('x-api-key') || body.model !== 'gpt-4o-mini'
      || body.messages?.length !== 1 || body.messages[0]?.role !== 'user' || body.messages[0]?.content !== `${KIND} synthetic request` || body.tools?.length) throw denied('outboundBlocked');
    options.signal?.throwIfAborted();
    counters.compatibilityDispatches = (counters.compatibilityDispatches || 0) + 1;
    const frames = [
      { id: KIND, object: 'chat.completion.chunk', model: 'gpt-4o-mini', choices: [{ index: 0, delta: { role: 'assistant', content: 'Controlled gateway answer.' }, finish_reason: null }] },
      { id: KIND, object: 'chat.completion.chunk', model: 'gpt-4o-mini', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22, prompt_tokens_details: { cached_tokens: 6 } } },
    ];
    return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
}
module.exports = { KIND, validateMarker, createPreviewTransport };
