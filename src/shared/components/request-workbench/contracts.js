// The local forms mirror gateway handlers; model/provider entitlement is checked by the gateway.
export const OPERATIONS = [
  { id: 'chat', label: 'Chat completion', group: 'Conversation', kind: 'llm', path: '/v1/chat/completions', fields: ['message'], template: { model: '', messages: [{ role: 'user', content: '' }], stream: false }, help: 'OpenAI Chat format. Image content, tools and reasoning remain available in the native body when supported by the selected model.' },
  { id: 'responses', label: 'Responses', group: 'Conversation', kind: 'llm', path: '/v1/responses', fields: ['input'], template: { model: '', input: '', stream: false }, help: 'OpenAI Responses format. Native items, tools and reasoning options depend on the translator and executor.' },
  { id: 'messages', label: 'Anthropic Messages', group: 'Conversation', kind: 'llm', path: '/v1/messages', fields: ['message'], template: { model: '', messages: [{ role: 'user', content: '' }], max_tokens: 1024, stream: false }, help: 'Anthropic Messages format, including native content blocks and tool results.' },
  { id: 'gemini', label: 'Gemini content', group: 'Conversation', kind: 'llm', path: '/v1beta/models/', fields: ['content'], template: { contents: [{ role: 'user', parts: [{ text: '' }] }] }, help: 'The URL action controls streaming. Do not add generationConfig.stream; it is not a supported Gemini field.' },
  { id: 'ollama', label: 'Ollama chat', group: 'Conversation', kind: 'llm', path: '/api/v1/api/chat', fields: ['message'], template: { model: '', messages: [{ role: 'user', content: '' }], stream: false }, help: 'Ollama-compatible chat response, including newline-delimited stream events.' },
  { id: 'image-generate', label: 'Generate image', group: 'Images', kind: 'image', path: '/v1/images/generations', fields: ['prompt'], connection: 'x-connection-id', template: { model: '', prompt: '' }, help: 'Image generation adapter options vary by model. Response can be native JSON, an event stream, or binary bytes.' },
  { id: 'image-edit', label: 'Edit image', group: 'Images', kind: 'image', path: '/v1/images/edits', fields: ['prompt'], connection: 'x-connection-id', files: 'image', template: { model: '', prompt: '' }, help: 'Upload 1–16 PNG, JPEG, WEBP or GIF images, at most 20 MiB each and 25 MiB combined. JSON data URLs/base64 also work. Remote image URLs, file_id and masks are refused.' },
  { id: 'embedding', label: 'Create embeddings', group: 'Text analysis', kind: 'embedding', path: '/v1/embeddings', fields: ['input'], template: { model: '', input: '' }, help: 'Native input may be text or an array. dimensions, encoding_format and input_type apply only to supporting providers. Missing usage remains unknown.' },
  { id: 'ocr', label: 'Read a document with OCR', group: 'Text analysis', kind: 'ocr', path: '/v1/ocr', fields: ['documentUrl'], template: { model: '', document: { type: 'document_url', document_url: '' } }, help: 'Mistral OCR requires a native document object. Provider-supported document/image options remain available in the native body.' },
  { id: 'moderation', label: 'Moderate content', group: 'Text analysis', kind: 'moderation', path: '/v1/moderations', fields: ['input'], template: { model: '', input: '' }, help: 'Mistral moderation accepts a string or array of strings. Native provider fields are forwarded.' },
  { id: 'rerank', label: 'Rank documents', group: 'Text analysis', kind: 'rerank', path: '/v1/rerank', fields: ['query', 'documents'], template: { model: '', query: '', documents: [], return_documents: true }, help: 'Cohere-shaped input works with Cohere, Jina, Together, SiliconFlow and Voyage. top_n and return_documents are normalized by the gateway.' },
  { id: 'speech', label: 'Generate speech', group: 'Audio', kind: 'tts', path: '/v1/audio/speech', fields: ['input', 'language', 'style'], template: { model: '', input: '' }, help: 'Select the provider/voice model ID returned by voice discovery. The handler uses the voice encoded in model, not a separate voice field. Audio defaults to mp3; JSON base64 is optional.' },
  { id: 'transcription', label: 'Transcribe audio', group: 'Audio', kind: 'stt', path: '/v1/audio/transcriptions', fields: ['language', 'prompt'], files: 'audio', template: { model: '' }, help: 'Multipart audio and model are required. Native language, prompt, response_format and timestamp_granularities[] fields are passed to the provider adapter.' },
  { id: 'voices', label: 'Discover voices', group: 'Audio', kind: 'tts', path: '/v1/audio/voices', method: 'GET', fields: ['language'], template: {}, help: 'This explicit lookup can contact the selected provider. Voice availability does not establish speech generation or entitlement.' },
  { id: 'search', label: 'Search the web', group: 'Web', kind: 'webSearch', path: '/v1/search', fields: ['query'], template: { model: '', query: '', max_results: 5 }, help: 'Native options include search_type, country, language, time_range, offset, domain_filter, content_options and provider_options.' },
  { id: 'fetch', label: 'Fetch a web page', group: 'Web', kind: 'webFetch', path: '/v1/web/fetch', fields: ['url'], template: { model: '', url: '', format: 'markdown' }, help: 'The gateway and provider validate public URLs. format and max_characters control extraction where supported. The browser does not fetch the target directly.' },
  { id: 'video-generate', label: 'Create video job', group: 'Video', kind: 'video', path: '/v1/videos/generations', fields: ['prompt'], connection: 'x-tokenproxy-connection-id', files: 'video', template: { model: '', prompt: '' }, help: 'xAI forwards native JSON or multipart. Gemini accepts JSON generation only. Acceptance creates an upstream job; it does not mean a video is complete.' },
  { id: 'video-edit', label: 'Edit video job', group: 'Video', kind: 'video', path: '/v1/videos/edits', fields: ['prompt'], connection: 'x-tokenproxy-connection-id', files: 'video', template: { model: '', prompt: '', video: { url: '' } }, help: 'xAI native edit body is forwarded. Use its source-video fields in the native body or multipart file fields. Gemini does not implement distinct editing.' },
  { id: 'video-extend', label: 'Extend video job', group: 'Video', kind: 'video', path: '/v1/videos/extensions', fields: ['prompt'], connection: 'x-tokenproxy-connection-id', files: 'video', template: { model: '', prompt: '', video: { url: '' } }, help: 'xAI native extension body is forwarded. Gemini does not implement distinct extension. Supply the source video and provider-specific controls.' },
  { id: 'video-poll', label: 'Check video job', group: 'Video', kind: 'video', path: '/v1/videos/', method: 'GET', fields: [], connection: 'x-tokenproxy-connection-id', template: {}, help: 'One explicit upstream status lookup. Return the creation response’s account header with the exact request_id. Cancel stops this lookup; it cannot cancel an upstream video job.' },
];
export const UNAVAILABLE = [
  { label: 'Standalone image understanding', reason: 'No /v1/images/understanding handler exists. Use image content in a supported chat format and vision-capable model.' },
  { label: 'Standalone music generation', reason: 'The music registry label has no /v1/audio/music handler.' },
  { label: 'Retained media gallery', reason: 'The gateway returns modality results without a retained media index or gallery API.' },
];
export const VOICE_PROVIDERS = ['elevenlabs', 'deepgram', 'inworld', 'minimax', 'minimax-cn', 'edge-tts', 'local-device'];
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_VIEW_CHARS = 100000;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string' && value.trim().length > 0;
export const operationById = id => OPERATIONS.find(operation => operation.id === id) || OPERATIONS[0];

export function initialDraft(operation) {
  return { native: JSON.stringify(operation.template, null, 2), model: '', provider: '', language: '', connection: '', jobId: '', idempotency: '', responseFormat: '', stream: false, encoding: operation.id === 'transcription' ? 'multipart' : 'json', fileField: 'video', files: [] };
}

export function parseBody(text) {
  if (text.length > 30 * 1024 * 1024) throw new Error('The local request editor is limited to 30 MiB.');
  let body;
  try { body = JSON.parse(text); } catch { throw new Error('Repair the native body. It must be valid JSON.'); }
  if (!object(body)) throw new Error('The native body must be a JSON object.');
  return body;
}

export function fieldValue(body, field) {
  if (field === 'message') return typeof body.messages?.[0]?.content === 'string' ? body.messages[0].content : '';
  if (field === 'content') return body.contents?.[0]?.parts?.[0]?.text || '';
  if (field === 'documentUrl') return body.document?.document_url || '';
  if (field === 'documents') return Array.isArray(body.documents) ? body.documents.map(item => typeof item === 'string' ? item : item?.text || '').join('\n') : '';
  return typeof body[field] === 'string' ? body[field] : '';
}

export function changeField(body, field, value) {
  if (field === 'message') return { ...body, messages: [{ role: 'user', content: value }] };
  if (field === 'content') return { ...body, contents: [{ role: 'user', parts: [{ text: value }] }] };
  if (field === 'documentUrl') return { ...body, document: { type: 'document_url', document_url: value } };
  if (field === 'documents') return { ...body, documents: value.split('\n').filter(line => line.trim()) };
  return { ...body, [field]: value };
}

function containsCredentialField(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => /^(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|client[-_]?secret|cookie)$/i.test(key) || containsCredentialField(child));
}

export function validateBody(operation, body, draft) {
  if (containsCredentialField(body)) throw new Error('Put the client key only in the dedicated password field. Credential fields are not accepted in the request body.');
  const model = operation.id === 'gemini' ? draft.model : body.model;
  if (!operation.method && operation.id !== 'gemini' && !string(model) && !(['search', 'fetch'].includes(operation.id) && string(body.provider))) throw new Error('Choose or enter the exact routed model ID.');
  if (operation.id === 'gemini' && (!string(model) || model.split('/').length > 2)) throw new Error('Enter a Gemini URL model as model or provider/model.');
  if (['chat', 'messages', 'ollama'].includes(operation.id) && (!Array.isArray(body.messages) || !body.messages.length)) throw new Error('messages must contain at least one native message.');
  if (operation.id === 'gemini' && (!Array.isArray(body.contents) || !body.contents.length)) throw new Error('contents must contain at least one native content item.');
  if (['responses', 'embedding', 'speech'].includes(operation.id) && !(string(body.input) || Array.isArray(body.input) && body.input.length)) throw new Error('Supply a nonempty input using the native format.');
  if (operation.id === 'speech' && !string(body.input)) throw new Error('Speech input must be nonempty text.');
  if (['image-generate', 'image-edit'].includes(operation.id) && !string(body.prompt)) throw new Error('Enter an image prompt.');
  if (['search', 'rerank'].includes(operation.id) && !string(body.query)) throw new Error('Enter a nonempty query.');
  if (operation.id === 'rerank' && (!Array.isArray(body.documents) || !body.documents.length || body.documents.some(item => typeof item !== 'string' && typeof item?.text !== 'string'))) throw new Error('documents must be a nonempty array of strings or objects with text.');
  if (operation.id === 'ocr' && !object(body.document)) throw new Error('document must be a native document object.');
  if (operation.id === 'moderation' && typeof body.input !== 'string' && !(Array.isArray(body.input) && body.input.every(item => typeof item === 'string'))) throw new Error('Moderation input must be a string or an array of strings.');
  if (operation.id === 'fetch') {
    let target;
    try { target = new URL(body.url); } catch { throw new Error('Enter a valid public HTTP or HTTPS URL.'); }
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Use a public HTTP or HTTPS URL without credentials. The gateway performs final network validation.');
  }
  if (operation.id === 'voices' && !VOICE_PROVIDERS.includes(draft.provider)) throw new Error('Choose a supported voice provider.');
  if (operation.id === 'video-poll' && !string(draft.jobId)) throw new Error('Enter the exact request_id returned by video creation.');
  if (operation.id.startsWith('video-') && operation.id !== 'video-poll') {
    const provider = String(model || '').split('/')[0];
    if (String(model).includes('/') && !['xai', 'gemini', 'gm'].includes(provider)) throw new Error('Only xAI and Gemini have implemented video adapters.');
    if (['gemini', 'gm'].includes(provider) && (operation.id !== 'video-generate' || draft.encoding !== 'json')) throw new Error('Gemini supports JSON video generation here; distinct edit, extension and multipart actions are unavailable.');
  }
  if (operation.id === 'image-edit') {
    if (body.mask != null) throw new Error('Image masks are not implemented by this gateway.');
    if (draft.encoding === 'json') {
      const sources = [...(Array.isArray(body.images) ? body.images : []), ...(Array.isArray(body.image) ? body.image : body.image == null ? [] : [body.image])];
      if (!sources.length || sources.length > 16) throw new Error('Include 1–16 image sources, or choose multipart and upload files.');
      for (const source of sources) {
        const value = typeof source === 'string' ? source : source?.image_url?.url || source?.image_url || source?.url || source?.b64_json;
        if (source?.file_id !== undefined || !string(value) || /^https?:/i.test(value)) throw new Error('Image edits accept image bytes or data URLs; remote URLs and file_id are unavailable.');
      }
    }
  }
  if (draft.encoding === 'multipart') {
    if (['image-edit', 'transcription'].includes(operation.id) && !draft.files.length) throw new Error('Select the required upload.');
    if (operation.id === 'image-edit' && (draft.files.length > 16 || draft.files.some(file => file.size > 20 * 1024 * 1024) || draft.files.reduce((sum, file) => sum + file.size, 0) > 25 * 1024 * 1024)) throw new Error('Image uploads must fit 16 files, 20 MiB each and 25 MiB combined.');
    if (operation.files === 'video' && !/^[a-zA-Z][a-zA-Z0-9_\[\]-]{0,63}$/.test(draft.fileField)) throw new Error('Enter the native multipart file field name.');
  }
  for (const value of [draft.connection, draft.idempotency]) if (/[\r\n]/.test(value)) throw new Error('Request headers cannot contain line breaks.');
}

export function prepareRequest(operation, draft) {
  const body = parseBody(draft.native);
  validateBody(operation, body, draft);
  let url = operation.path;
  if (operation.id === 'gemini') url += `${draft.model.split('/').map(encodeURIComponent).join('/')}:${draft.stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
  if (operation.id === 'voices') url += `?${new URLSearchParams({ provider: draft.provider, ...(draft.language ? { lang: draft.language } : {}) })}`;
  if (operation.id === 'video-poll') url += encodeURIComponent(draft.jobId);
  if (draft.responseFormat && ['speech', 'image-generate', 'image-edit'].includes(operation.id)) url += `?response_format=${encodeURIComponent(draft.responseFormat)}`;
  const headers = {};
  if (operation.connection && draft.connection) headers[operation.connection] = draft.connection;
  if (operation.id.startsWith('video-') && operation.id !== 'video-poll' && draft.idempotency) headers['Idempotency-Key'] = draft.idempotency;
  if (draft.stream && ['image-generate', 'image-edit'].includes(operation.id)) headers.Accept = 'text/event-stream';
  let payload;
  if (!operation.method && draft.encoding === 'multipart') {
    payload = new FormData();
    for (const [key, value] of Object.entries(body)) {
      if (Array.isArray(value) && key.startsWith('timestamp_granularities')) for (const item of value) payload.append(key.endsWith('[]') ? key : `${key}[]`, String(item));
      else payload.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    const fileField = operation.files === 'audio' ? 'file' : operation.files === 'image' ? 'image[]' : draft.fileField;
    for (const file of draft.files) payload.append(fileField, file);
  } else if (!operation.method) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  return { operation: operation.id, url, method: operation.method || 'POST', headers, body: payload, nativeBody: body, fileCount: draft.files.length, model: body.model || draft.model || body.provider || null };
}

export function redactText(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets.filter(value => typeof value === 'string' && value.length)) text = text.split(secret).join('[redacted]');
  return text.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]').replace(/((?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|client[-_]?secret)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]');
}

export async function sendGateway(prepared, { clientKey, signal, onProgress, fetchImpl = fetch }) {
  const operation = OPERATIONS.find(item => item.id === prepared.operation);
  const expected = operation?.path;
  if (!operation || prepared.method !== (operation.method || 'POST') || !prepared.url.startsWith('/') || prepared.url.startsWith('//') || !(operation.id === 'gemini' || operation.id === 'video-poll' ? prepared.url.startsWith(expected) : prepared.url.split('?')[0] === expected)) throw new Error('Only the selected same-origin gateway operation can be sent.');
  if (!clientKey?.trim()) throw new Error('Enter a client API key for this explicit gateway request.');
  if (/[\r\n]/.test(clientKey) || prepared.url.includes(clientKey) || prepared.url.includes(encodeURIComponent(clientKey)) || JSON.stringify(prepared.nativeBody).includes(clientKey) || Object.values(prepared.headers).some(value => String(value).includes(clientKey))) throw new Error('Client keys belong only in the authorization header.');
  const startedAt = new Date().toISOString();
  const response = await fetchImpl(prepared.url, { method: prepared.method, headers: { ...prepared.headers, Authorization: `Bearer ${clientKey}` }, body: prepared.body, signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
  const contentType = redactText(response.headers.get('content-type') || 'application/octet-stream', [clientKey]);
  const textual = /json|text|xml|javascript/.test(contentType);
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, rawText = '', truncated = false;
  const chunks = [];
  try {
    if (reader) while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_RESPONSE_BYTES - bytes;
      const chunk = value.subarray(0, Math.max(remaining, 0));
      bytes += chunk.byteLength;
      if (textual) {
        rawText += decoder.decode(chunk, { stream: true });
        // Keep the incomplete tail private until it cannot be a split credential.
        const protectedTail = Math.max(clientKey.length, 256);
        onProgress?.({ bytes, text: redactText(rawText.slice(0, Math.max(0, rawText.length - protectedTail)), [clientKey]).slice(0, MAX_VIEW_CHARS) });
      } else chunks.push(chunk);
      if (chunk.byteLength < value.byteLength || bytes >= MAX_RESPONSE_BYTES || truncated) { truncated = true; await reader.cancel(); break; }
    }
  } finally { reader?.releaseLock(); }
  if (textual && !truncated) rawText += decoder.decode();
  if (textual && !truncated) { try { rawText = JSON.stringify(JSON.parse(rawText), null, 2); } catch { /* Preserve native non-JSON stream events. */ } }
  const safeText = redactText(rawText, [clientKey]);
  const text = safeText.slice(0, MAX_VIEW_CHARS);
  let data;
  if (textual && !truncated) { try { data = JSON.parse(safeText); } catch { /* Stream and plain-text responses remain readable text. */ } }
  return { operation: prepared.operation, status: response.status, ok: response.ok, contentType, bytes, truncated, viewTruncated: safeText.length > MAX_VIEW_CHARS, text, data, blob: !truncated ? new Blob(textual ? [safeText] : chunks, { type: textual ? 'text/plain' : contentType }) : null, startedAt, completedAt: new Date().toISOString(), connectionId: redactText(response.headers.get('x-tokenproxy-connection-id') || '', [clientKey]), requestId: redactText(response.headers.get('x-request-id') || '', [clientKey]) };
}

// Diagnostic exports deliberately omit native prompts, uploads, output bodies and arbitrary headers.
export function diagnosticExport(result) {
  return { version: 'request-workbench-v1', scope: 'single explicit gateway response', operation: operationById(result.operation).id, status: result.status, contentType: result.contentType, bytes: result.bytes, truncated: result.truncated, startedAt: result.startedAt, completedAt: result.completedAt, content: 'Request and response content, credentials, files and account identifiers omitted.', inferenceCompletion: 'HTTP success is not proof of completed user work; video jobs require an explicit status check.' };
}
