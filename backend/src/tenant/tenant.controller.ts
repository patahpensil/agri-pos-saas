import { Controller, Get, Inject, Req, UseGuards } from "@nestjs/common";
import { DbService } from "../db/db.service";
import { db } from "../common/errors";
import { AuthedRequest, SessionGuard } from "../auth/session.guard";

@Controller()
export class TenantController {
  constructor(@Inject(DbService) private readonly dbs: DbService) {}

  // Toko, peran, paket, dan masa berlaku ditentukan server (ENT-03), tidak pernah dari klien.
  @Get("tenant/me")
  @UseGuards(SessionGuard)
  async me(@Req() req: AuthedRequest) {
    const r = await db(this.dbs.withActor(req.sessionToken!, (c) => c.query<{ me: unknown }>("select app.tenant_me() as me")));
    return r.rows[0].me;
  }
}
