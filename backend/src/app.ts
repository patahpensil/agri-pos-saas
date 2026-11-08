import "reflect-metadata";
import { INestApplication, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { randomUUID } from "node:crypto";
import express, { NextFunction, Request, Response } from "express";
import { AppConfig, ConfigError } from "./config/config";
import { CONFIG } from "./tokens";
import { DbService } from "./db/db.service";
import { ProblemFilter } from "./common/problem.filter";
import { log } from "./common/log";
import { AuthController } from "./auth/auth.controller";
import { OTP_SENDER, OtpSender, TestOtpSender } from "./auth/otp-sender";
import { SessionGuard } from "./auth/session.guard";
import { TenantController } from "./tenant/tenant.controller";
import { StaffController } from "./staff/staff.controller";
import { HealthController } from "./health/health.controller";

export interface CreatedApp {
  app: INestApplication;
  db: DbService;
  otpSender: OtpSender;
}

// Produksi: semua parameter keamanan di database wajib ada dan tidak boleh berlabel test_only.
export async function checkSecurityParams(dbs: DbService, cfg: AppConfig): Promise<void> {
  if (cfg.mode !== "production") return;
  const r = await dbs.auth.query<{ r_key: string; r_present: boolean; r_test_only: boolean }>(
    "select * from iam.security_params_status()",
  );
  const missing = r.rows.filter((x) => !x.r_present).map((x) => x.r_key);
  const testOnly = r.rows.filter((x) => x.r_test_only).map((x) => x.r_key);
  if (missing.length || testOnly.length) {
    throw new ConfigError(
      `Parameter keamanan produksi belum sah. Kosong: [${missing.join(", ")}]; TEST_ONLY: [${testOnly.join(", ")}]`,
    );
  }
}

export async function createApp(cfg: AppConfig, opts: { otpSender?: OtpSender } = {}): Promise<CreatedApp> {
  // Pengaman lapis kedua untuk G3: pengirim palsu tidak pernah dipasang di produksi.
  const otpSender = opts.otpSender ?? (cfg.otpSender === "test" ? new TestOtpSender() : undefined);
  if (!otpSender) throw new ConfigError("Pengirim OTP belum dikonfigurasi");
  if (cfg.mode === "production" && otpSender.kind === "test") {
    throw new ConfigError("Pengirim OTP palsu dilarang di produksi");
  }

  const dbs = new DbService(cfg);
  try {
    await checkSecurityParams(dbs, cfg);
  } catch (e) {
    await dbs.close();
    throw e;
  }

  @Module({
    controllers: [AuthController, TenantController, StaffController, HealthController],
    providers: [
      { provide: CONFIG, useValue: cfg },
      { provide: DbService, useValue: dbs },
      { provide: OTP_SENDER, useValue: otpSender },
      SessionGuard,
    ],
  })
  class AppModule {}

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false, bodyParser: false });
  app.disable("x-powered-by");
  app.set("trust proxy", cfg.trustProxyHops);

  // Correlation ID + log akses (tanpa body/header sensitif).
  app.use((req: Request, res: Response, next: NextFunction) => {
    const given = req.header("X-Correlation-ID");
    const id = given && /^[0-9a-f-]{36}$/i.test(given) ? given : randomUUID();
    res.setHeader("X-Correlation-ID", id);
    res.setHeader("Cache-Control", "no-store");
    const t0 = Date.now();
    res.on("finish", () =>
      log({ level: "info", msg: "http", method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t0, correlationId: id }),
    );
    next();
  });
  // Body JSON ketat: objek/array saja, maks 16 KB.
  app.use(express.json({ limit: "16kb", strict: true, type: "application/json" }));
  app.setGlobalPrefix("api/v1");
  app.useGlobalFilters(new ProblemFilter());
  app.enableShutdownHooks();
  return { app, db: dbs, otpSender };
}
