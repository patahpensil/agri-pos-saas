import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, UseGuards } from "@nestjs/common";
import { createHmac } from "node:crypto";
import { Request } from "express";
import { CONFIG } from "../tokens";
import { AppConfig } from "../config/config";
import { DbService } from "../db/db.service";
import { AppError, db, notFound, rateLimited } from "../common/errors";
import { isUuid, parseBody, schemas } from "../common/validation";
import { dispatchOtps, OTP_SENDER, OtpSender, otpMac } from "./otp-sender";
import { AuthedRequest, SessionGuard } from "./session.guard";

type IpKind = "IP_REGISTER" | "IP_LOGIN" | "IP_ACTIVATE";

const otpInvalid = () => new AppError(400, "OTP_INVALID", "Kode OTP tidak sah atau sudah tidak berlaku");
const otpLocked = () => new AppError(429, "OTP_LOCKED", "Terlalu banyak percobaan OTP");

@Controller()
export class AuthController {
  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(OTP_SENDER) private readonly sender: OtpSender,
  ) {}

  private async ipGate(req: Request, kind: IpKind): Promise<void> {
    const ip = req.ip ?? "unknown";
    const h = createHmac("sha256", this.cfg.ipHashSecret).update(ip).digest();
    const r = await db(this.dbs.auth.query<{ ok: boolean }>("select iam.ip_rate_hit($1, $2) as ok", [kind, h]));
    if (!r.rows[0]?.ok) throw rateLimited();
  }

  @Post("auth/register/start")
  @HttpCode(202)
  async registerStart(@Req() req: Request, @Body() body: unknown) {
    const b = parseBody(schemas.registerStart, body);
    await this.ipGate(req, "IP_REGISTER");
    const r = await db(this.dbs.auth.query<{ s: string }>("select iam.register_start($1) as s", [b.phone]));
    if (r.rows[0].s === "RATE_LIMITED") throw rateLimited();
    await dispatchOtps(this.dbs.otp, this.sender, this.cfg.otpMacKey);
    return { status: "OTP_SENT_IF_ELIGIBLE" };
  }

  @Post("auth/register/verify-otp")
  @HttpCode(201)
  async registerVerify(@Req() req: Request, @Body() body: unknown) {
    const b = parseBody(schemas.registerVerify, body);
    await this.ipGate(req, "IP_REGISTER");
    const r = await db(
      this.dbs.auth.query<{ r_status: string; r_token: string; r_expires_at: Date; r_tenant: string }>(
        "select * from iam.register_verify($1, $2, $3, $4, $5, $6)",
        [b.phone, otpMac(this.cfg.otpMacKey, "REGISTER_OWNER", b.phone, b.code), b.password, b.businessName, b.timezone, b.deviceId],
      ),
    );
    const row = r.rows[0];
    if (row.r_status === "OTP_LOCKED") throw otpLocked();
    if (row.r_status !== "OK") throw otpInvalid();
    return { token: row.r_token, expiresAt: row.r_expires_at, tenantId: row.r_tenant, role: "OWNER", plan: "FREE" };
  }

  @Post("auth/login")
  @HttpCode(200)
  async login(@Req() req: Request, @Body() body: unknown) {
    const b = parseBody(schemas.login, body);
    await this.ipGate(req, "IP_LOGIN");
    const r = await db(
      this.dbs.auth.query<{ r_status: string; r_token: string; r_expires_at: Date }>(
        "select * from iam.login($1, $2, $3)",
        [b.phone, b.password, b.deviceId],
      ),
    );
    const row = r.rows[0];
    if (row.r_status === "RATE_LIMITED") throw rateLimited();
    if (row.r_status !== "OK") throw new AppError(401, "INVALID_CREDENTIALS", "Nomor HP atau kata sandi salah");
    return { token: row.r_token, expiresAt: row.r_expires_at };
  }

  @Post("auth/staff-activation/verify")
  @HttpCode(201)
  async activateAdmin(@Req() req: Request, @Body() body: unknown) {
    const b = parseBody(schemas.activateAdmin, body);
    await this.ipGate(req, "IP_ACTIVATE");
    const r = await db(
      this.dbs.auth.query<{ r_status: string; r_token: string; r_expires_at: Date }>(
        "select * from iam.activate_admin($1, $2, $3, $4)",
        [b.phone, otpMac(this.cfg.otpMacKey, "ACTIVATE_ADMIN", b.phone, b.code), b.password, b.deviceId],
      ),
    );
    const row = r.rows[0];
    if (row.r_status === "OTP_LOCKED") throw otpLocked();
    if (row.r_status === "PHONE_NOT_AVAILABLE") throw new AppError(409, "PHONE_NOT_AVAILABLE", "Nomor HP tidak dapat dipakai");
    if (row.r_status !== "OK") throw otpInvalid();
    return { token: row.r_token, expiresAt: row.r_expires_at, role: "ADMIN" };
  }

  @Post("auth/logout")
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async logout(@Req() req: AuthedRequest, @Body() body: unknown) {
    parseBody(schemas.empty, body);
    await db(this.dbs.withActor(req.sessionToken!, (c) => c.query("select app.logout()")));
  }

  @Get("auth/sessions")
  @UseGuards(SessionGuard)
  async sessions(@Req() req: AuthedRequest) {
    const r = await db(
      this.dbs.withActor(req.sessionToken!, (c) =>
        c.query<{ r_id: string; r_device_id: string; r_created_at: Date; r_expires_at: Date; r_current: boolean }>(
          "select * from app.session_list()",
        ),
      ),
    );
    return {
      sessions: r.rows.map((s) => ({
        id: s.r_id,
        deviceId: s.r_device_id,
        createdAt: s.r_created_at,
        expiresAt: s.r_expires_at,
        current: s.r_current,
      })),
    };
  }

  @Post("auth/sessions/:id/revoke")
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async revoke(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown) {
    parseBody(schemas.empty, body);
    if (!isUuid(id)) throw notFound();
    await db(this.dbs.withActor(req.sessionToken!, (c) => c.query("select app.session_revoke($1)", [id])));
  }
}
