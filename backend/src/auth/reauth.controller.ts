import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from "@nestjs/common";
import { DbService } from "../db/db.service";
import { AppError, db, rateLimited } from "../common/errors";
import { parseBody, schemas } from "../common/validation";
import { AuthedRequest, SessionGuard } from "./session.guard";

// AUTH-04 / INV-AUD-01: Owner memasukkan ulang sandi untuk SATU aksi sensitif pada SATU objek.
// Sandi diperiksa database; yang dikembalikan hanyalah token sekali pakai berumur pendek.
@Controller("auth")
@UseGuards(SessionGuard)
export class ReauthController {
  constructor(@Inject(DbService) private readonly dbs: DbService) {}

  @Post("reauth")
  @HttpCode(201)
  async reauth(@Req() req: AuthedRequest, @Body() body: unknown) {
    const b = parseBody(schemas.reauth, body);
    const r = await db(
      this.dbs.withActor(req.sessionToken!, (c) =>
        c.query<{ r: { status: string; reauthToken?: string; expiresAt?: string } }>(
          "select app.reauth_start($1, $2, $3) as r",
          [b.password, b.action, b.targetId.toLowerCase()],
        ),
      ),
    );
    const res = r.rows[0].r;
    if (res.status === "RATE_LIMITED") throw rateLimited();
    if (res.status !== "OK") throw new AppError(401, "REAUTH_INVALID", "Sandi tidak cocok");
    return { reauthToken: res.reauthToken, expiresAt: res.expiresAt, action: b.action, targetId: b.targetId.toLowerCase() };
  }
}
