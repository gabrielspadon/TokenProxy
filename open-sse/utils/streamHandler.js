// Stream handler with disconnect detection - shared for all providers
import {
  STREAM_STALL_TIMEOUT_MS,
  SSE_KEEPALIVE_MS,
} from "../config/runtimeConfig.js";
import { dbg, isDebugEnabled } from "./debugLog.js";

const keepaliveEncoder = new TextEncoder();

// A controller may arrive without isConnected (a test double, or a caller
// wiring a plain object); fall back to the abort signal it does carry rather
// than throwing inside a stream pull.
function controllerIsConnected(sc) {
  return typeof sc?.isConnected === "function"
    ? sc.isConnected()
    : !sc?.signal?.aborted;
}

// Get HH:MM:SS timestamp
function getTimeString() {
  return new Date().toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// A cancel reason is produced by the RUNTIME, not by this repo: Next cancels a
// response stream with `new ResponseAborted()`, an Error whose message is empty,
// so the DISCONNECT line read as a bare "ResponseAborted" (#2843). Keep the
// identity, bound the length, and never interpolate whatever a caller attached
// to AbortSignal.abort(reason) — that value is not ours and may be large.
const MAX_REASON_CHARS = 120;
function describeReason(reason) {
  if (reason == null) return "client_closed";
  if (typeof reason === "string") return reason.slice(0, MAX_REASON_CHARS) || "client_closed";
  const name = typeof reason.name === "string" ? reason.name : "";
  const message = typeof reason.message === "string" ? reason.message : "";
  if (name) return (message ? `${name}: ${message}` : name).slice(0, MAX_REASON_CHARS);
  return String(reason).slice(0, MAX_REASON_CHARS);
}

// Counters and flags only — never request or response content.
function describeDetail(detail) {
  if (!detail) return "";
  return Object.entries(detail)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => ` · ${k}=${v}`)
    .join("");
}

/**
 * Create stream controller with abort and disconnect detection
 * @param {object} options
 * @param {function} options.onDisconnect - Callback when client disconnects
 * @param {object} options.log - Logger instance
 * @param {string} options.provider - Provider name
 * @param {string} options.model - Model name
 */
export function createStreamController({
  onDisconnect,
  onError,
  log,
  provider,
  model,
  reqTag = "",
} = {}) {
  const abortController = new AbortController();
  const startTime = Date.now();
  let disconnected = false;
  let abortTimeout = null;

  // Only abnormal terminations are logged; normal completion is covered by "📊 done".
  // isError uses errorLine (always shown, ignores LOG_LEVEL) so failures survive quiet levels.
  const logStream = (symbol, status, isError = false) => {
    const duration = Date.now() - startTime;
    const emit = isError ? log?.errorLine : log?.line;
    if (emit)
      emit(reqTag, symbol, `${status} · ${provider}/${model} · ${duration}ms`);
    else
      console.log(
        `[${getTimeString()}] ${symbol} ${provider}/${model} · ${status} · ${duration}ms`,
      );
  };

  return {
    signal: abortController.signal,
    startTime,

    isConnected: () => !disconnected,

    // Call when client disconnects
    // `detail` carries stream progress (counters, terminal-seen flag) so the line
    // distinguishes a client that left after a fully delivered answer from one
    // that left mid-stream. `reason` is passed to onDisconnect untouched.
    handleDisconnect: (reason = "client_closed", detail = null) => {
      if (disconnected) return;
      disconnected = true;

      const label = describeReason(reason);
      logStream("⚡", `DISCONNECT: ${label}${describeDetail(detail)}`);
      dbg(
        "CTRL",
        `${provider}/${model} | disconnect=${label} | dur=${Date.now() - startTime}ms`,
      );

      // Delay abort to allow cleanup
      abortTimeout = setTimeout(() => {
        abortController.abort();
      }, 500);

      onDisconnect?.({ reason, duration: Date.now() - startTime });
    },

    // Call when stream completes normally (no line here — "📊 done" is authoritative)
    handleComplete: () => {
      if (disconnected) return;
      disconnected = true;

      if (abortTimeout) {
        clearTimeout(abortTimeout);
        abortTimeout = null;
      }
    },

    // Call on error
    handleError: (error) => {
      if (disconnected) return;
      disconnected = true;

      if (abortTimeout) {
        clearTimeout(abortTimeout);
        abortTimeout = null;
      }

      if (error.name === "AbortError") {
        logStream("⚡", "ABORTED");
        return;
      }

      logStream(
        "✗",
        `ERROR: ${error.message}${error.stack ? `\n    ${error.stack}` : ""}`,
        true,
      );
      onError?.(error);
    },

    abort: () => abortController.abort(),
  };
}

/**
 * Create transform stream with disconnect detection
 * Wraps existing transform stream and adds abort capability.
 *
 * Stall detection lives in pipeWithDisconnect (tied to upstream byte
 * activity), not here — output of the transform stream may be silent
 * for long periods while raw bytes still flow (e.g. Kiro EventStream
 * binary frames buffering, Claude reasoning streams).
 */
export function createDisconnectAwareStream(
  transformStream,
  streamController,
  onAbortTerminal = null,
  {
    terminalObserver = null,
    onIncompleteStream = null,
    onTerminalFailureReady = null,
    callerSignal = null,
  } = {},
) {
  const reader = transformStream.readable.getReader();
  const writer = transformStream.writable.getWriter();
  let terminalEmitted = false;
  let incompleteHandled = false;
  let downstreamCancelled = false;
  let outputController = null;
  let outputClosed = false;
  let callerAbortHandled = false;
  let removeCallerAbortListener = null;

  // Emit a synthesized terminal payload (e.g. Responses response.failed + [DONE]) once
  const emitTerminal = (controller) => {
    if (terminalEmitted || !onAbortTerminal) return;
    terminalEmitted = true;
    try {
      const bytes = onAbortTerminal();
      if (bytes) controller.enqueue(bytes);
    } catch {
      /* best-effort terminal */
    }
  };

  const emitIncompleteTerminal = (controller) => {
    if (terminalEmitted) return;
    terminalEmitted = true;
    try {
      const bytes = terminalObserver?.buildIncompleteTerminal?.() || onAbortTerminal?.();
      if (bytes) controller.enqueue(bytes);
    } catch {
      /* best-effort terminal */
    }
  };

  const handleIncomplete = (controller, error) => {
    if (incompleteHandled) return;
    incompleteHandled = true;
    emitIncompleteTerminal(controller);
    try {
      onIncompleteStream?.(error);
    } catch {
      /* existing lifecycle errors must not hide the terminal */
    }
    streamController.handleError(error);
    terminalObserver?.release?.();
  };

  // "did the client already receive the whole answer?" — the one fact that makes
  // a DISCONNECT report actionable. Read before release() clears the observer.
  const terminalDetail = () =>
    terminalObserver ? { terminal: terminalObserver.sawTerminal() ? "yes" : "no" } : null;

  const closeOutput = (controller) => {
    if (outputClosed) return;
    outputClosed = true;
    removeCallerAbortListener?.();
    removeCallerAbortListener = null;
    controller.close();
  };

  const terminateCallerAbort = () => {
    if (callerAbortHandled) return;
    callerAbortHandled = true;
    streamController.handleDisconnect("caller_aborted", terminalDetail());
    terminalObserver?.release?.();
    reader.cancel(callerSignal?.reason).catch(() => {});
    writer.abort(callerSignal?.reason).catch(() => {});
    if (outputController) closeOutput(outputController);
  };

  const terminateIncomplete = (error) => {
    if (
      !terminalObserver
      || downstreamCancelled
      || incompleteHandled
      || terminalObserver.sawTerminal()
      || !outputController
    ) {
      return false;
    }
    handleIncomplete(outputController, error);
    closeOutput(outputController);
    reader.cancel().catch(() => {});
    writer.abort().catch(() => {});
    return true;
  };

  onTerminalFailureReady?.(terminateIncomplete);

  return new ReadableStream({
    start(controller) {
      outputController = controller;
      if (callerSignal) {
        const onCallerAbort = () => terminateCallerAbort();
        if (callerSignal.aborted) {
          onCallerAbort();
        } else {
          callerSignal.addEventListener("abort", onCallerAbort, { once: true });
          removeCallerAbortListener = () => callerSignal.removeEventListener("abort", onCallerAbort);
        }
      }
    },

    async pull(controller) {
      if (callerAbortHandled || callerSignal?.aborted) {
        terminateCallerAbort();
        return;
      }

      if (!controllerIsConnected(streamController)) {
        if (terminalObserver && !downstreamCancelled && !terminalObserver.sawTerminal()) {
          terminateIncomplete(new Error("stream ended before terminal event"));
        } else {
          emitTerminal(controller);
          terminalObserver?.release?.();
        }
        closeOutput(controller);
        return;
      }

      try {
        const { done, value } = await reader.read();

        if (done) {
          if (terminalObserver && !terminalObserver.sawTerminal()) {
            terminateIncomplete(new Error("stream ended before terminal event"));
          } else {
            streamController.handleComplete();
            terminalObserver?.release?.();
          }
          closeOutput(controller);
          return;
        }
        terminalObserver?.observe?.(value);
        controller.enqueue(value);
      } catch (error) {
        if (callerAbortHandled || callerSignal?.aborted) {
          terminateCallerAbort();
          return;
        }
        const wasConnected = controllerIsConnected(streamController);
        // Controller already closed = downstream ended; not an upstream error, skip noisy log.
        const msg0 = error?.message || "";
        const isControllerClosed =
          msg0.includes("already closed") || msg0.includes("Invalid state");
        reader.cancel().catch(() => {});
        writer.abort().catch(() => {});

        if (terminalObserver) {
          if (terminalObserver.sawTerminal()) {
            streamController.handleComplete();
            terminalObserver.release();
            closeOutput(controller);
            return;
          }
          if (!isControllerClosed && !downstreamCancelled) {
            terminateIncomplete(error);
          } else {
            terminalObserver.release();
          }
          closeOutput(controller);
          return;
        }

        if (!isControllerClosed) streamController.handleError(error);

        // Only reachable with no terminalObserver — the branch above owns every
        // emitted format that has an exact terminal predicate. Here nothing can
        // prove the answer was finished, so the distinction that matters is who
        // ended it.
        //
        // A caller that walked away is a graceful end. An upstream socket that
        // died mid-answer is not, and this used to bundle the two: ECONNRESET /
        // ETIMEDOUT / EPIPE / socket hang up all closed the client stream
        // cleanly, so a truncated answer arrived as a complete HTTP 200 with no
        // error anywhere in it. A client cannot tell that from a short reply, so
        // it accepts it or retries the whole turn — which is what an unreliable
        // proxy in front of the upstream looks like from the outside: "HTTP 200
        // proxy error" and every model suddenly slow (#1513). Erroring the
        // stream is the only signal left that the answer is incomplete.
        const msg = error?.message || "";
        const code = error?.code || error?.cause?.code || "";
        const isCallerAbort =
          error.name === "AbortError" || msg.includes("aborted") || code === "ABORT_ERR";

        // Graceful close on a caller abort, or when a structured terminal is available
        // (Responses passthrough prefers response.failed + [DONE] over a raw transport error)
        try {
          if (!wasConnected || isCallerAbort || onAbortTerminal) {
            emitTerminal(controller);
            controller.close();
          } else {
            controller.error(error);
          }
        } catch (e) {
          /* already closed or cancelled */
        }
      }
    },

    cancel(reason) {
      downstreamCancelled = true;
      removeCallerAbortListener?.();
      removeCallerAbortListener = null;
      streamController.handleDisconnect(reason || "cancelled", terminalDetail());
      terminalObserver?.release?.();
      reader.cancel().catch(() => {});
      writer.abort().catch(() => {});
    },
  });
}

function normalizePipeOptions(
  onAbortTerminalOrOptions,
  stallTimeoutMs,
  ttftTimeoutMs,
  keepaliveMs,
) {
  if (
    onAbortTerminalOrOptions
    && typeof onAbortTerminalOrOptions === "object"
    && !Array.isArray(onAbortTerminalOrOptions)
  ) {
    return {
      onAbortTerminal: onAbortTerminalOrOptions.onAbortTerminal ?? null,
      stallTimeoutMs: onAbortTerminalOrOptions.stallTimeoutMs ?? STREAM_STALL_TIMEOUT_MS,
      ttftTimeoutMs: onAbortTerminalOrOptions.ttftTimeoutMs ?? 30000,
      keepaliveMs: onAbortTerminalOrOptions.keepaliveMs ?? SSE_KEEPALIVE_MS,
      terminalObserver: onAbortTerminalOrOptions.terminalObserver ?? null,
      onIncompleteStream: onAbortTerminalOrOptions.onIncompleteStream ?? null,
      callerSignal: onAbortTerminalOrOptions.callerSignal ?? null,
    };
  }

  return {
    onAbortTerminal: onAbortTerminalOrOptions ?? null,
    stallTimeoutMs,
    ttftTimeoutMs,
    keepaliveMs,
    terminalObserver: null,
    onIncompleteStream: null,
    callerSignal: null,
  };
}

/**
 * Pipe provider response through transform with disconnect detection.
 *
 * Stall watchdog tracks raw upstream byte activity, not transform output.
 * Reasoning models (Claude thinking via Kiro, etc.) can produce zero SSE
 * output for long stretches while partial EventStream frames keep arriving.
 * Measuring stall on the transform output caused false stalls and the
 * "failed to pipe response" error in Next.
 *
 * Any upstream chunk resets the timer. If no bytes arrive for
 * STREAM_STALL_TIMEOUT_MS, abort the underlying fetch via the controller.
 *
 * @param {Response} providerResponse - Response from provider
 * @param {TransformStream} transformStream - Transform stream for SSE
 * ttftTimeoutMs is a separate first-byte watchdog, decoupled from the shared
 * STREAM_FIRST_CHUNK_TIMEOUT_MS constant: combo.js and kiro.js use that
 * constant (200s) as a prefill patience budget, while TTFT is fail-fast.
 *
 * @param {object} streamController - Stream controller from createStreamController
 */
export function pipeWithDisconnect(
  providerResponse,
  transformStream,
  streamController,
  onAbortTerminalOrOptions = null,
  stallTimeoutMs = STREAM_STALL_TIMEOUT_MS,
  ttftTimeoutMs = 30000,
  keepaliveMs = SSE_KEEPALIVE_MS,
) {
  const options = normalizePipeOptions(
    onAbortTerminalOrOptions,
    stallTimeoutMs,
    ttftTimeoutMs,
    keepaliveMs,
  );
  ({ stallTimeoutMs, ttftTimeoutMs, keepaliveMs } = options);
  const { onAbortTerminal, terminalObserver, onIncompleteStream, callerSignal } = options;
  let terminateWithTerminal = null;
  let stallTimer = null;
  let firstChunkTimer = null;
  let keepaliveTimer = null;
  let chunkCount = 0;
  let totalBytes = 0;
  let lastChunkAt = Date.now();
  const t0 = Date.now();
  const tag = "STREAM";

  // TTFT watchdog: if no upstream bytes arrive within the TTFT window, abort.
  // Fires only once; cleared by the first upstream byte (or any termination).
  // Separate from the inter-chunk stall watchdog so slow-but-healthy streams
  // (e.g. reasoning models with long prefill) are never falsely aborted.
  const clearFirstChunk = () => {
    if (firstChunkTimer) {
      clearTimeout(firstChunkTimer);
      firstChunkTimer = null;
    }
  };
  const armFirstChunk = () => {
    clearFirstChunk();
    firstChunkTimer = setTimeout(() => {
      firstChunkTimer = null;
      dbg(tag, `TTFT TIMEOUT ${ttftTimeoutMs}ms | no bytes received`);
      stopKeepalive();
      wrappedController.handleError(
        new Error(`stream ttft timeout (${ttftTimeoutMs}ms)`),
      );
      streamController.abort?.();
    }, ttftTimeoutMs);
  };

  const clearStall = () => {
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };
  // SSE keepalive: emits ping frames downstream during EVERY silent interval,
  // pre-TTFT and mid-stream alike. Three properties this arrangement owns:
  //
  //   1. A heartbeat is transport, never content. The timer is mounted on the
  //      OUTBOUND side (after transformStream), so a ping is enqueued past the
  //      translator and can never reach its input — upstream see PR #3457's
  //      pre-tap version, which fed pings back through the translator.
  //   2. A heartbeat is not provider progress. Only `upstreamTap` touches
  //      `armStall`, `lastChunkAt` and `chunkCount`, and it sits UPSTREAM of
  //      this timer, so no ping can reach it. A hung provider therefore still
  //      trips the stall watchdog on schedule while the client keeps seeing
  //      liveness — the two clocks are independent by construction, not by
  //      convention.
  //   3. A heartbeat cannot outlive the stream. `stopKeepalive` latches, so a
  //      byte flushed by the translator after upstream EOF re-arms nothing.
  //
  // Re-armed after every downstream write (a self-rescheduling timeout, not an
  // interval), so a ping fires only during genuine silence and never interleaves
  // with real data.
  const KEEPALIVE_FRAME = "event: ping\ndata: {}\n\n";
  let keepaliveStopped = false;
  let keepaliveController = null;
  let heartbeatCount = 0;

  const clearKeepalive = () => {
    if (keepaliveTimer) {
      clearTimeout(keepaliveTimer);
      keepaliveTimer = null;
    }
  };
  // Terminal: clears AND latches, so nothing downstream can resurrect the ping.
  const stopKeepalive = () => {
    keepaliveStopped = true;
    clearKeepalive();
  };
  const armKeepalive = () => {
    clearKeepalive();
    if (keepaliveStopped || !(keepaliveMs > 0)) return;
    keepaliveTimer = setTimeout(() => {
      keepaliveTimer = null;
      if (keepaliveStopped || !keepaliveController) return;
      if (!controllerIsConnected(streamController)) return;
      // Backpressure: a negative desiredSize means the queue has grown past the
      // high-water mark because the client is not reading. Skip this beat rather
      // than stacking bytes on a congested socket. A TransformStream readable
      // sits at highWaterMark 0, so idle is exactly 0 and only a real backlog
      // goes negative.
      // ponytail: skip-a-beat, not a drain event — a readable controller exposes
      // no drain signal, and the next arm retries one interval later.
      if (!(keepaliveController.desiredSize < 0)) {
        try {
          keepaliveController.enqueue(keepaliveEncoder.encode(KEEPALIVE_FRAME));
          heartbeatCount++;
          dbg(tag, `keepalive ping #${heartbeatCount} (silence=${keepaliveMs}ms)`);
        } catch {
          stopKeepalive();
          return;
        }
      }
      armKeepalive();
    }, keepaliveMs);
  };
  const armStall = () => {
    clearStall();
    stallTimer = setTimeout(() => {
      stallTimer = null;
      dbg(
        tag,
        `STALL TIMEOUT ${stallTimeoutMs}ms | chunks=${chunkCount} | bytes=${totalBytes} | sinceLast=${Date.now() - lastChunkAt}ms`,
      );
      wrappedController.handleError(new Error("stream stall timeout"));
      streamController.abort?.();
    }, stallTimeoutMs);
  };

  // Wrap controller so every termination path clears both timers.
  // Without this, abort/cancel/downstream-error paths leave the timers armed
  // and a stale abort could fire after the request has already ended.
  const wrappedController = {
    signal: streamController.signal,
    startTime: streamController.startTime,
    isConnected: () => controllerIsConnected(streamController),
    handleComplete: () => {
      dbg(
        tag,
        `complete | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`,
      );
      clearFirstChunk();
      clearStall();
      stopKeepalive();
      streamController.handleComplete?.();
    },
    handleError: (e) => {
      dbg(
        tag,
        `error: ${e?.message} | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`,
      );
      clearFirstChunk();
      clearStall();
      stopKeepalive();
      if (terminalObserver && terminateWithTerminal?.(e)) return;
      streamController.handleError?.(e);
    },
    handleDisconnect: (r, detail) => {
      dbg(
        tag,
        `disconnect: ${r} | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`,
      );
      clearFirstChunk();
      clearStall();
      stopKeepalive();
      streamController.handleDisconnect?.(r, {
        up: `${chunkCount}c/${totalBytes}b`,
        ...detail,
      });
    },
    abort: () => {
      clearFirstChunk();
      clearStall();
      stopKeepalive();
      streamController.abort?.();
    },
  };

  armFirstChunk();
  armStall();
  dbg(
    tag,
    `pipe start | ttftTimeout=${ttftTimeoutMs}ms | stallTimeout=${stallTimeoutMs}ms | keepalive=${keepaliveMs}ms`,
  );

  const upstreamTap = new TransformStream({
    transform(chunk, controller) {
      chunkCount++;
      const sz = chunk?.byteLength || chunk?.length || 0;
      totalBytes += sz;
      const now = Date.now();
      const gap = now - lastChunkAt;
      lastChunkAt = now;
      if (
        isDebugEnabled &&
        (chunkCount <= 5 || chunkCount % 20 === 0 || gap > 5000)
      ) {
        dbg(
          tag,
          `chunk #${chunkCount} | size=${sz}B | gap=${gap}ms | total=${totalBytes}B`,
        );
      }
      clearFirstChunk(); // first byte received — TTFT watchdog satisfied
      armStall();
      controller.enqueue(chunk);
    },
    flush() {
      dbg(
        tag,
        `upstream EOF | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`,
      );
      clearStall();
      // Upstream EOF stops the UPSTREAM clock, but the translator may still
      // flush buffered output downstream, so the heartbeat is left armed and
      // the tap's own flush() latches it once that output is done.
    },
  });

  const transformedBody = providerResponse.body
    .pipeThrough(upstreamTap)
    .pipeThrough(transformStream)
    .pipeThrough(
      // Downstream keepalive tap. It sees only TRANSLATED output, so re-arming
      // on `transform` measures downstream silence — the interval the client
      // actually experiences — while the upstream stall clock keeps measuring
      // provider silence in `upstreamTap`, one stage earlier. Neither can move
      // the other.
      new TransformStream({
        start(controller) {
          keepaliveController = controller;
          armKeepalive();
        },
        transform(chunk, controller) {
          controller.enqueue(chunk);
          // A real byte just went downstream: restart the silence window so a
          // ping never interleaves with data mid-stream.
          armKeepalive();
        },
        flush() {
          stopKeepalive();
        },
        cancel() {
          stopKeepalive();
        },
      }),
    );

  return createDisconnectAwareStream(
    {
      readable: transformedBody,
      writable: { getWriter: () => ({ abort: () => Promise.resolve() }) },
    },
    wrappedController,
    onAbortTerminal,
    {
      terminalObserver,
      onIncompleteStream,
      callerSignal,
      onTerminalFailureReady: (terminate) => {
        terminateWithTerminal = terminate;
      },
    },
  );
}
