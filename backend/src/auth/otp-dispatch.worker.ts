import { Inject, Injectable, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { CONFIG } from "../tokens";
import { AppConfig } from "../config/config";
import { DbService } from "../db/db.service";
import { log } from "../common/log";
import { dispatchOtps, OTP_SENDER, OtpSender } from "./otp-sender";

// R4-01: pemroses antrean OTP berkala. Mengambil ulang pekerjaan yang gagal dikirim atau yang
// lease-nya habis (worker mati), tanpa menunggu permintaan API baru. Aman dijalankan di banyak
// instance sekaligus karena klaim memakai lease + FOR UPDATE SKIP LOCKED di database.
// Putaran tidak tumpang tindih di dalam satu proses.
@Injectable()
export class OtpDispatchWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(OTP_SENDER) private readonly sender: OtpSender,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), this.cfg.otpDispatchIntervalMs);
    this.timer.unref();
  }

  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      await dispatchOtps(this.dbs.otp, this.sender, this.cfg.otpMacKey);
    } catch {
      log({ level: "error", msg: "otp_dispatch_tick_failed", code: "OTP_DISPATCH_FAILED" });
    } finally {
      this.running = false;
    }
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }
}
