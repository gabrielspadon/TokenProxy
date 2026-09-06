import { registerShutdownFlusher } from '../shutdown.js';
import { createHttpTelemetry } from './httpTelemetry.js';

export function telemetryOptions(env = process.env) {
  if (env.TOKENPROXY_TELEMETRY !== 'otlp') return null;
  if (!env.TOKENPROXY_OTEL_ENDPOINT || env.TOKENPROXY_OTEL_ENDPOINT.length > 2048) throw new Error('Invalid telemetry endpoint');
  const endpoint = new URL(env.TOKENPROXY_OTEL_ENDPOINT);
  if (!['http:','https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Invalid telemetry endpoint');
  const sampleRatio = env.TOKENPROXY_OTEL_SAMPLE_RATIO === undefined ? .01 : Number(env.TOKENPROXY_OTEL_SAMPLE_RATIO);
  if (!Number.isFinite(sampleRatio) || sampleRatio < 0 || sampleRatio > 1 || env.TOKENPROXY_OTEL_SAMPLE_RATIO === '') throw new Error('Invalid telemetry sampling ratio');
  return { endpoint: endpoint.href.replace(/\/$/,''), sampleRatio };
}

export async function createTechnicalTelemetry(options, { traceExporter, metricExporter } = {}) {
  const [api,tracing,metrics,resources,traceOtlp,metricOtlp] = await Promise.all([
    import('@opentelemetry/api'), import('@opentelemetry/sdk-trace'), import('@opentelemetry/sdk-metrics'),
    import('@opentelemetry/resources'), import('@opentelemetry/exporter-trace-otlp-http'), import('@opentelemetry/exporter-metrics-otlp-http'),
  ]);
  const resource = resources.resourceFromAttributes({ 'service.name': 'tokenproxy' });
  const exportOptions = { headers: {}, concurrencyLimit: 1, timeoutMillis: 1000 };
  let tracerProvider, meterProvider, http, spans, reader;
  try {
  spans = new tracing.BatchSpanProcessor({
    exporter: traceExporter ?? new traceOtlp.OTLPTraceExporter({ ...exportOptions, url: `${options.endpoint}/v1/traces` }),
    maxQueueSize: 1024, maxExportBatchSize: 128, scheduledDelayMillis: 5000, exportTimeoutMillis: 1000,
  });
  tracerProvider = new tracing.TracerProvider({ resource,
    sampler: new tracing.TraceIdRatioBasedSampler(options.sampleRatio), spanProcessors: [spans],
    spanLimits: { attributeCountLimit: 8, attributeValueLengthLimit: 64, eventCountLimit: 0, linkCountLimit: 0 },
  });
  reader = new metrics.PeriodicExportingMetricReader({
    exporter: metricExporter ?? new metricOtlp.OTLPMetricExporter({ ...exportOptions, url: `${options.endpoint}/v1/metrics` }),
    exportIntervalMillis: 10000, exportTimeoutMillis: 1000,
  });
  meterProvider = new metrics.MeterProvider({ resource, readers: [reader],
    views: [
      ...['tokenproxy.http.duration','tokenproxy.http.first_body_write'].map(instrumentName => ({
        instrumentName, aggregationCardinalityLimit: 1024,
        aggregation: { type: metrics.AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: { boundaries: [.00025,.0005,.001,.002,.005,.01,.025,.05,.1,.25,.5,1,2.5,5,10,30,60,120,300,600,1800] } },
      })),
      ...['tokenproxy.http.active','tokenproxy.http.completed'].map(instrumentName => ({ instrumentName,aggregationCardinalityLimit:1024 })),
    ],
  });
  http = createHttpTelemetry({ tracer: tracerProvider.getTracer('tokenproxy.http'), meter: meterProvider.getMeter('tokenproxy.runtime'), rootContext: api.ROOT_CONTEXT });
  let closing;
  return { observe: http.observe,
    forceFlush: () => Promise.all([tracerProvider.forceFlush(),meterProvider.forceFlush()]),
    shutdown() {
      http.stop();
      return closing ??= Promise.allSettled([tracerProvider.shutdown(),meterProvider.shutdown()]);
    },
  };
  } catch (error) {
    http?.stop();
    await Promise.allSettled([tracerProvider ? tracerProvider.shutdown() : spans?.shutdown(),
      meterProvider ? meterProvider.shutdown() : reader?.shutdown()]);
    throw error;
  }
}

// No SDK initialization or export occurs without the explicit operator setting.
// A private provider avoids adopting Next's global tracing or incoming baggage.
export async function initializeTechnicalTelemetry() {
  if (globalThis.__tokenproxyTechnicalTelemetrySetup) return globalThis.__tokenproxyTechnicalTelemetrySetup;
  globalThis.__tokenproxyTechnicalTelemetrySetup = (async () => {
    try {
      const options = telemetryOptions();
      if (!options) return;
      const runtime = await createTechnicalTelemetry(options);
      globalThis.__tokenproxyTechnicalTelemetry = runtime;
      registerShutdownFlusher(() => runtime.shutdown(),80);
    } catch {
      console.warn('[telemetry] Technical export is unavailable; request accounting remains independent.');
    }
  })();
  return globalThis.__tokenproxyTechnicalTelemetrySetup;
}
