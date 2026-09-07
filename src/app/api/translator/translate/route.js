import { NextResponse } from "next/server";
import { detectFormat, getTargetFormat } from "open-sse/services/provider.js";
import { translateRequest, describeTranslationRoute } from "open-sse/translator/index.js";
import { isSecretBodyKey, redactSecrets, stripSensitiveHeaders } from "open-sse/utils/redact.js";
import { FORMATS } from "open-sse/translator/formats.js";
import { getModelInfo } from "@/sse/services/model.js";
import { getProviderConnections } from "@/lib/localDb.js";
import { getExecutor } from "open-sse/executors/index.js";

function unavailable(route) {
  return NextResponse.json({ success: false, code: 'route_unavailable', error: 'A registered local conversion path is unavailable. No passthrough was substituted.', route }, { status: 422 });
}

// Diagnostics must never become another credential reveal surface. Exact known
// credential values are removed even if an executor embeds them under a custom key.
function diagnostic(value, credentials) {
  const secrets = [];
  const collect = (item, sensitive = false) => {
    if (typeof item === 'string') {
      if (sensitive && item.length >= 4) secrets.push(item);
    } else if (Array.isArray(item)) item.forEach(child => collect(child, sensitive));
    else if (item && typeof item === 'object') Object.entries(item).forEach(([key, child]) => {
      const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replaceAll('_', '-');
      collect(child, sensitive || isSecretBodyKey(normalized) || /(?:^|-)(?:token|secret|password|credentials?)$/.test(normalized));
    });
  };
  collect(credentials);
  const scrub = (item) => {
    if (typeof item === 'string') return secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), item);
    if (Array.isArray(item)) return item.map(scrub);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, scrub(child)]));
    return item;
  };
  return scrub(redactSecrets(value));
}

function diagnosticUrl(value) {
  try {
    const url = new URL(value);
    url.username = ''; url.password = ''; url.hash = '';
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[redacted]');
    return url.toString();
  } catch { return '[unavailable URL]'; }
}

export async function POST(request) {
  try {
    const { step, body } = await request.json();

    if (!step || !body) {
      return NextResponse.json({ success: false, error: "Step and body required" }, { status: 400 });
    }

    switch (step) {
      case 1: {
        // Detect provider + formats from 1_req_client.json
        const clientBody = body.body || body;
        const { provider, model } = await getModelInfo(clientBody.model);
        const sourceFormat = detectFormat(clientBody);
        const targetFormat = getTargetFormat(provider);
        const route = describeTranslationRoute(sourceFormat, targetFormat);
        return NextResponse.json({ success: true, result: { provider, model, sourceFormat, targetFormat, route, scope: 'local-format-detection', providerCalls: 0 } });
      }

      case 2: {
        // source → OpenAI intermediate (mirrors 3_req_openai.json)
        // Translate source→openai only (half of the pipeline)
        const clientBody = body.body || body;
        const { provider, model } = await getModelInfo(clientBody.model);
        const sourceFormat = detectFormat(clientBody);
        const stream = clientBody.stream !== false;
        const route = describeTranslationRoute(sourceFormat, FORMATS.OPENAI);
        if (!route.supported) return unavailable(route);

        // translateRequest(source, OPENAI) = only the first half
        const result = translateRequest(sourceFormat, FORMATS.OPENAI, model, clientBody, stream, null, provider);
        delete result._toolNameMap;

        return NextResponse.json({ success: true, result: { body: result, route, sourceFormat, targetFormat: FORMATS.OPENAI, scope: 'local-conversion', providerCalls: 0 } });
      }

      case 3: {
        // OpenAI intermediate → target + build URL/headers (mirrors 4_req_target.json)
        const openaiBody = body.body || body;
        const provider = body.provider;
        const model = body.model;

        if (!provider || !model) {
          return NextResponse.json({ success: false, error: "provider and model required" }, { status: 400 });
        }

        // Resolve the stored connection before selecting its target API format.
        const connections = await getProviderConnections({ provider });
        const connection = connections.find(c => c.isActive !== false);
        if (!connection) {
          return NextResponse.json({ success: false, error: `No active connection for provider: ${provider}` }, { status: 400 });
        }

        const credentials = {
          apiKey: connection.apiKey,
          accessToken: connection.accessToken,
          refreshToken: connection.refreshToken,
          copilotToken: connection.copilotToken,
          projectId: connection.projectId,
          providerSpecificData: connection.providerSpecificData
        };

        const targetFormat = getTargetFormat(provider, credentials);
        const stream = openaiBody.stream !== false;
        const route = describeTranslationRoute(FORMATS.OPENAI, targetFormat);
        if (!route.supported) return unavailable(route);

        // translateRequest(OPENAI, target) = second half of pipeline
        const translated = translateRequest(FORMATS.OPENAI, targetFormat, model, openaiBody, stream, credentials, provider);
        delete translated._toolNameMap;

        // Build URL + headers via executor (same as chatCore → executor.execute)
        const executor = getExecutor(provider);
        const url = executor.buildUrl(model, stream, 0, credentials);
        const headers = executor.buildHeaders(credentials, stream);
        const finalBody = executor.transformRequest(model, translated, stream, credentials);

        return NextResponse.json({ success: true, result: {
          ...diagnostic({ url: diagnosticUrl(url), headers: stripSensitiveHeaders(headers), body: finalBody }, credentials),
          route, sourceFormat: FORMATS.OPENAI, targetFormat, connectionId: connection.id,
          scope: 'local-executor-construction', providerCalls: 0, credentialsRead: true,
          diagnosticRedaction: 'Credential headers omitted, URL credentials/query values removed, known credential values redacted. This diagnostic is not a replay-ready request.',
        } });
      }

      default:
        return NextResponse.json({ success: false, error: "Invalid step (1-3)" }, { status: 400 });
    }
  } catch (error) {
    console.error("Error in local translator:", error?.name || 'Error');
    return NextResponse.json({ success: false, error: 'The local translator could not construct this diagnostic. No upstream test was performed.' }, { status: 500 });
  }
}
