import { DbService } from "../db/db.service";
import { log } from "../common/log";

// Antarmuka pengirim OTP (G3): tidak terikat penyedia tertentu. Penyedia produksi belum dipilih.
export interface OtpSender {
  readonly kind: string;
  send(phoneE164: string, code: string): Promise<void>;
}

// HANYA untuk pengujian. Konfigurasi menolak OTP_SENDER=test di mode produksi (config.ts),
// dan createApp() menolak memasang pengirim ini bila mode bukan 'test'/'development'.
export class TestOtpSender implements OtpSender {
  readonly kind = "test";
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

// Mengambil kode dari kotak keluar database (role otp_dispatch_runtime) lalu mengirimkannya.
// Kode tidak pernah dicatat ke log.
export async function dispatchOtps(db: DbService, sender: OtpSender): Promise<void> {
  const r = await db.otp.query<{ r_phone: string; r_code: string }>("select r_phone, r_code from iam.otp_dispatch_claim($1)", [50]);
  for (const row of r.rows) {
    try {
      await sender.send(row.r_phone, row.r_code);
    } catch {
      log({ level: "error", msg: "otp_send_failed", code: "OTP_SEND_FAILED" });
    }
  }
}
