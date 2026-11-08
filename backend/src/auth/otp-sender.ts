import { createHmac, randomInt } from "node:crypto";
import { log } from "../common/log";

// Antarmuka pengirim OTP (G3): tidak terikat penyedia tertentu. Penyedia produksi belum dipilih.
// send() wajib melempar error bila penyedia tidak mengonfirmasi keberhasilan.
export interface OtpSender {
  readonly kind: string;
  send(phoneE164: string, code: string): Promise<void>;
}

// HANYA untuk pengujian. Konfigurasi menolak OTP_SENDER=test di mode produksi (config.ts),
// dan createApp() menolak memasang pengirim ini pada mode produksi.
export class TestOtpSender implements OtpSender {
  readonly kind: string = "test";
  private readonly inbox = new Map<string, string[]>();

  async send(phoneE164: string, code: string): Promise<void> {
    const list = this.inbox.get(phoneE164) ?? [];
    list.push(code);
    this.inbox.set(phoneE164, list);
  }

  last(phoneE164: string): string | undefined {
    const l = this.inbox.get(phoneE164);
    return l?.[l.length - 1];
  }

  count(phoneE164: string): number {
    return this.inbox.get(phoneE164)?.length ?? 0;
  }
}

export const OTP_SENDER = Symbol("OTP_SENDER");

export type OtpPurpose = "REGISTER_OWNER" | "ACTIVATE_ADMIN";

// MAC kode OTP. Kunci hanya ada di backend (OTP_MAC_KEY), tidak di database, sehingga salinan
// database tanpa kunci tidak bisa dipakai menebak kode secara offline.
export function otpMac(key: Buffer, purpose: OtpPurpose, phoneE164: string, code: string): Buffer {
  return createHmac("sha256", key).update(`${purpose}|${phoneE164}|${code}`).digest();
}

export interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface DispatchStats {
  claimed: number;
  sent: number;
  failed: number;
  skipped: number;
}

// Worker pengiriman (role otp_dispatch_runtime). Alur per pekerjaan:
//   claim (lease, SKIP LOCKED) -> buat kode acak -> simpan MAC kode (hanya bila lease sah)
//   -> kirim -> ack (SENT) | fail (kembali ke antrean secara terbatas).
// Jaminan: minimal sekali (at-least-once) dengan batas percobaan; bukan exactly-once.
// Kode mentah hanya ada di memori proses ini selama pengiriman; tidak pernah ke database atau log.
export async function dispatchOtps(pool: Queryable, sender: OtpSender, macKey: Buffer, limit = 50): Promise<DispatchStats> {
  const stats: DispatchStats = { claimed: 0, sent: 0, failed: 0, skipped: 0 };
  const jobs = await pool.query<{ r_job: string; r_lease: Buffer; r_purpose: OtpPurpose; r_phone: string }>(
    "select * from iam.otp_dispatch_claim($1)",
    [limit],
  );
  for (const j of jobs.rows) {
    stats.claimed++;
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const set = await pool.query<{ ok: boolean }>("select iam.otp_dispatch_set_code($1, $2, $3) as ok", [
      j.r_job,
      j.r_lease,
      otpMac(macKey, j.r_purpose, j.r_phone, code),
    ]);
    if (!set.rows[0]?.ok) {
      stats.skipped++;
      continue;
    }
    try {
      await sender.send(j.r_phone, code);
    } catch {
      stats.failed++;
      log({ level: "error", msg: "otp_send_failed", code: "OTP_SEND_FAILED" });
      await pool.query("select iam.otp_dispatch_fail($1, $2)", [j.r_job, j.r_lease]);
      continue;
    }
    await pool.query("select iam.otp_dispatch_ack($1, $2)", [j.r_job, j.r_lease]);
    stats.sent++;
  }
  return stats;
}
