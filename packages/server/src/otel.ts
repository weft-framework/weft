import type { ErrorReport } from "./app.ts";
import { redact } from "./log.ts";
import type { Secret } from "./secret.ts";

export interface Telemetry {
  startRequest(req: Request): TraceContext;
  endRequest(t: TraceContext, info: { method: string; route?: string; path: string; status: number }): void;
  error(err: unknown, report: ErrorReport, t: TraceContext | null): void;
  span?(name: string, o?: SpanOptions): Span;
}

type Attr = string | number | boolean | undefined;

export interface SpanOptions {
  kind?: "internal" | "consumer";
  parent?: TraceContext | null;
  attributes?: Record<string, Attr>;
  elapsedMs?: number;
  metric?: { name: string; attributes: Record<string, Attr> };
}

export interface Span {
  readonly context: TraceContext;
  end(o?: { error?: unknown; attributes?: Record<string, Attr> }): void;
}

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  start: number;
}

export interface OtlpOptions {
  endpoint: string;
  headers?: Record<string, string | Secret>;
  service: string;
  resource?: Record<string, string | number | boolean>;
  batchMs?: number;
  maxBatch?: number;
  maxQueue?: number;
  metricsMs?: number;
  maxSeries?: number;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  onError?(err: unknown): void;
  now?(): number;
}

export interface OtlpExporter extends Telemetry {
  flush(): Promise<void>;
  readonly dropped: number;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

function hex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

type AnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };

function value(v: unknown): AnyValue {
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { stringValue: typeof v === "string" ? v : JSON.stringify(redact(v)) };
}

function attributes(o: Record<string, unknown>): { key: string; value: AnyValue }[] {
  return Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([key, v]) => ({ key, value: value(v) }));
}

const nanos = (ms: number) => `${BigInt(Math.round(ms * 1000)) * 1000n}`;

const BOUNDS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10];

const DESCRIPTIONS: Record<string, string> = {
  "http.server.request.duration": "Duration of HTTP server requests.",
  "weft.live.event.duration": "Duration of live page events.",
  "weft.job.duration": "Duration of job runs.",
};

interface Series {
  attributes: Record<string, Attr>;
  count: number;
  sum: number;
  min: number;
  max: number;
  buckets: number[];
}

const errorType = (err: unknown) => (err instanceof Error ? err.name : typeof err);

export function otlpExporter(o: OtlpOptions): OtlpExporter {
  let base: URL;
  try {
    base = new URL(o.endpoint);
  } catch {
    throw new Error("otlpExporter: endpoint is a URL");
  }
  if (base.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) {
    throw new Error("otlpExporter: endpoint must be https (http only for a local collector)");
  }
  if (typeof o.service !== "string" || o.service === "") throw new Error("otlpExporter: service names the service");
  const batchMs = o.batchMs ?? 2000;
  const maxBatch = o.maxBatch ?? 512;
  const maxQueue = o.maxQueue ?? 2048;
  const metricsMs = o.metricsMs ?? 60_000;
  const maxSeries = o.maxSeries ?? 1000;
  for (const [k, v, lo] of [
    ["batchMs", batchMs, 10],
    ["maxBatch", maxBatch, 1],
    ["maxQueue", maxQueue, 1],
    ["metricsMs", metricsMs, 1000],
    ["maxSeries", maxSeries, 1],
  ] as const) {
    if (!Number.isInteger(v) || v < lo) throw new Error(`otlpExporter: ${k} is a whole number of at least ${lo}`);
  }
  if (metricsMs > 3600_000) throw new Error("otlpExporter: metricsMs is at most 1 hour");
  const doFetch = o.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const onError = o.onError ?? ((err: unknown) => console.error("[weft] otlp:", err));
  const now = o.now ?? Date.now;
  const root = base.href.endsWith("/") ? base.href : `${base.href}/`;
  const resource = { attributes: attributes({ "service.name": o.service, "telemetry.sdk.name": "weft", ...o.resource }) };
  const scope = { name: "@weft-framework/server" };

  const spans: object[] = [];
  const logs: object[] = [];
  let dropped = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sending: Promise<void> = Promise.resolve();

  const headers = () => {
    const h: Record<string, string> = { "content-type": "application/json" };
    for (const [k, v] of Object.entries(o.headers ?? {})) h[k] = typeof v === "string" ? v : v.reveal();
    return h;
  };

  const post = async (path: string, body: object) => {
    try {
      const res = await doFetch(root + path, { method: "POST", headers: headers(), body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`OTLP ${path} answered HTTP ${res.status}`);
      await res.body?.cancel().catch(() => undefined);
    } catch (err) {
      onError(err);
    }
  };

  const send = (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const s = spans.splice(0, maxBatch);
    const l = logs.splice(0, maxBatch);
    const jobs: Promise<void>[] = [];
    if (s.length) jobs.push(post("v1/traces", { resourceSpans: [{ resource, scopeSpans: [{ scope, spans: s }] }] }));
    if (l.length) jobs.push(post("v1/logs", { resourceLogs: [{ resource, scopeLogs: [{ scope, logRecords: l }] }] }));
    sending = sending.then(() => Promise.all(jobs)).then(() => undefined);
    if (spans.length || logs.length) schedule();
    return sending;
  };

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => void send(), batchMs);
    (timer as { unref?: () => void }).unref?.();
  };

  const started = now();
  const metrics = new Map<string, Map<string, Series>>();
  let metricTimer: ReturnType<typeof setTimeout> | null = null;
  const OVERFLOW = JSON.stringify([["otel.metric.overflow", true]]);

  const record = (name: string, attrs: Record<string, Attr>, seconds: number) => {
    let byKey = metrics.get(name);
    if (!byKey) metrics.set(name, (byKey = new Map()));
    const clean = Object.entries(attrs).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    let key = JSON.stringify(clean);
    let s = byKey.get(key);
    if (!s && byKey.size >= maxSeries) {
      key = OVERFLOW;
      s = byKey.get(key);
      clean.splice(0, clean.length, ["otel.metric.overflow", true]);
    }
    if (!s) {
      s = { attributes: Object.fromEntries(clean), count: 0, sum: 0, min: Infinity, max: -Infinity, buckets: new Array(BOUNDS.length + 1).fill(0) };
      byKey.set(key, s);
    }
    const v = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    s.count++;
    s.sum += v;
    s.min = Math.min(s.min, v);
    s.max = Math.max(s.max, v);
    let i = 0;
    while (i < BOUNDS.length && v > BOUNDS[i]!) i++;
    s.buckets[i]!++;
    if (!metricTimer) {
      metricTimer = setTimeout(() => void sendMetrics(), metricsMs);
      (metricTimer as { unref?: () => void }).unref?.();
    }
  };

  const sendMetrics = (): Promise<void> => {
    if (metricTimer) {
      clearTimeout(metricTimer);
      metricTimer = null;
    }
    if (metrics.size === 0) return sending;
    const at = nanos(now());
    const from = nanos(started);
    const body = {
      resourceMetrics: [{
        resource,
        scopeMetrics: [{
          scope,
          metrics: [...metrics].map(([name, byKey]) => ({
            name,
            unit: "s",
            description: DESCRIPTIONS[name] ?? "",
            histogram: {
              aggregationTemporality: 2,
              dataPoints: [...byKey.values()].map((s) => ({
                attributes: attributes(s.attributes),
                startTimeUnixNano: from,
                timeUnixNano: at,
                count: String(s.count),
                sum: s.sum,
                min: s.min,
                max: s.max,
                bucketCounts: s.buckets.map(String),
                explicitBounds: BOUNDS,
              })),
            },
          })),
        }],
      }],
    };
    sending = sending.then(() => post("v1/metrics", body));
    metricTimer = setTimeout(() => void sendMetrics(), metricsMs);
    (metricTimer as { unref?: () => void }).unref?.();
    return sending;
  };

  const queue = (list: object[], item: object) => {
    list.push(item);
    if (spans.length + logs.length > maxQueue) {
      (spans.length >= logs.length ? spans : logs).shift();
      dropped++;
    }
    if (list.length >= maxBatch) void send();
    else schedule();
  };

  return {
    get dropped() {
      return dropped;
    },
    startRequest(req) {
      const parent = TRACEPARENT.exec(req.headers.get("traceparent") ?? "");
      const valid = parent && !/^0+$/.test(parent[1]!) && !/^0+$/.test(parent[2]!);
      return {
        traceId: valid ? parent[1]! : hex(16),
        spanId: hex(8),
        ...(valid ? { parentSpanId: parent[2]! } : {}),
        start: now(),
      };
    },
    endRequest(t, info) {
      queue(spans, {
        traceId: t.traceId,
        spanId: t.spanId,
        ...(t.parentSpanId ? { parentSpanId: t.parentSpanId } : {}),
        name: info.route ? `${info.method} ${info.route}` : info.method,
        kind: 2,
        startTimeUnixNano: nanos(t.start),
        endTimeUnixNano: nanos(now()),
        attributes: attributes({
          "http.request.method": info.method,
          "http.route": info.route,
          "url.path": info.path,
          "http.response.status_code": info.status,
        }),
        status: info.status >= 500 ? { code: 2 } : { code: 0 },
      });
      record(
        "http.server.request.duration",
        {
          "http.request.method": info.method,
          "http.route": info.route,
          "http.response.status_code": info.status,
          "error.type": info.status >= 500 ? String(info.status) : undefined,
        },
        (now() - t.start) / 1000,
      );
    },
    span(name, so = {}) {
      const parent = so.parent ?? null;
      const context: TraceContext = {
        traceId: parent ? parent.traceId : hex(16),
        spanId: hex(8),
        ...(parent ? { parentSpanId: parent.spanId } : {}),
        start: Math.max(parent?.start ?? -Infinity, now() - (Number.isFinite(so.elapsedMs) && so.elapsedMs! > 0 ? so.elapsedMs! : 0)),
      };
      let ended = false;
      return {
        context,
        end(eo = {}) {
          if (ended) return;
          ended = true;
          const failed = eo.error !== undefined;
          queue(spans, {
            traceId: context.traceId,
            spanId: context.spanId,
            ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {}),
            name,
            kind: so.kind === "consumer" ? 5 : 1,
            startTimeUnixNano: nanos(context.start),
            endTimeUnixNano: nanos(now()),
            attributes: attributes({ ...so.attributes, ...eo.attributes, "error.type": failed ? errorType(eo.error) : undefined }),
            status: failed ? { code: 2 } : { code: 0 },
          });
          if (so.metric) {
            const extra = failed ? { "error.type": errorType(eo.error) } : {};
            record(so.metric.name, { ...so.metric.attributes, ...extra }, (now() - context.start) / 1000);
          }
        },
      };
    },
    error(err, report, t) {
      const e = err instanceof Error ? err : null;
      queue(logs, {
        timeUnixNano: nanos(now()),
        severityNumber: 17,
        severityText: "ERROR",
        body: { stringValue: e ? e.message : String(redact(err)) },
        ...(t ? { traceId: t.traceId, spanId: t.spanId } : {}),
        attributes: attributes({
          "exception.type": e ? e.name : typeof err,
          "exception.message": e ? e.message : undefined,
          "exception.stacktrace": e?.stack,
          "weft.kind": report.kind,
          "http.route": report.route,
          "weft.component": report.component,
          "weft.handler": report.handler,
          "enduser.id": report.actor,
          "url.path": report.path,
          "http.request.method": report.method,
          "service.instance.id": report.instance,
        }),
      });
    },
    flush: () => {
      void send();
      return sendMetrics();
    },
  };
}
