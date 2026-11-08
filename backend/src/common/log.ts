// Logger terstruktur dengan daftar-putih field. Body request, header Authorization, OTP, sandi,
// token, dan nomor HP TIDAK pernah dicatat. redact() tetap dijalankan sebagai pengaman kedua.
export type LogSink = (line: string) => void;

let sink: LogSink = (line) => {
  process.stdout.write(line + "\n");
};

export function setLogSink(s: LogSink): void {
  sink = s;
}

const ALLOWED = new Set(["level", "msg", "method", "path", "status", "ms", "correlationId", "code"]);

export function redact(text: string): string {
  return text
    .replace(/\b[0-9a-f]{64}\b/gi, "[token]")
    .replace(/\+?62[0-9]{8,13}\b|\b0[0-9]{9,13}\b/g, "[phone]")
    .replace(/\b[0-9]{6}\b/g, "[digits6]");
}

export function log(fields: Record<string, string | number | undefined>): void {
  const out: Record<string, string | number> = { t: new Date().toISOString() };
  for (const [k, v] of Object.entries(fields)) {
    if (ALLOWED.has(k) && v !== undefined) out[k] = typeof v === "string" ? redact(v) : v;
  }
  sink(JSON.stringify(out));
}
