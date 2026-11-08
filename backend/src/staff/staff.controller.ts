import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, UseGuards } from "@nestjs/common";
import { DbService } from "../db/db.service";
import { CONFIG } from "../tokens";
import { AppConfig } from "../config/config";
import { db, notFound } from "../common/errors";
import { isUuid, parseBody, schemas } from "../common/validation";
import { AuthedRequest, SessionGuard } from "../auth/session.guard";
import { dispatchOtps, OTP_SENDER, OtpSender } from "../auth/otp-sender";

// Pengelolaan Admin Bisnis (G1, O-2, O-3). Peran OWNER, paket PRO, dan kuota diperiksa di database.
@Controller("staff")
@UseGuards(SessionGuard)
export class StaffController {
  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(DbService) private readonly dbs: DbService,
    @Inject(OTP_SENDER) private readonly sender: OtpSender,
  ) {}

  @Get()
  async list(@Req() req: AuthedRequest) {
    const r = await db(
      this.dbs.withActor(req.sessionToken!, (c) =>
        c.query<{
          r_id: string; r_role: string; r_state: string; r_display_name: string;
          r_created_at: Date; r_activated_at: Date | null; r_deactivated_at: Date | null;
        }>("select * from app.staff_list()"),
      ),
    );
    return {
      staff: r.rows.map((m) => ({
        id: m.r_id, role: m.r_role, state: m.r_state, displayName: m.r_display_name,
        createdAt: m.r_created_at, activatedAt: m.r_activated_at, deactivatedAt: m.r_deactivated_at,
      })),
    };
  }

  @Post()
  @HttpCode(202)
  async invite(@Req() req: AuthedRequest, @Body() body: unknown) {
    const b = parseBody(schemas.staffInvite, body);
    const r = await db(
      this.dbs.withActor(req.sessionToken!, (c) =>
        c.query<{ id: string }>("select app.staff_invite($1, $2) as id", [b.phone, b.displayName]),
      ),
    );
    await dispatchOtps(this.dbs.otp, this.sender, this.cfg.otpMacKey);
    return { staffId: r.rows[0].id, state: "PENDING_ACTIVATION" };
  }

  @Post(":id/deactivate")
  @HttpCode(204)
  async deactivate(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown) {
    parseBody(schemas.empty, body);
    if (!isUuid(id)) throw notFound();
    await db(this.dbs.withActor(req.sessionToken!, (c) => c.query("select app.staff_deactivate($1)", [id])));
  }
}
