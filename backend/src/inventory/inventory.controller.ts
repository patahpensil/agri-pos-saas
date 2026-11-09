import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { DbService } from "../db/db.service";
import { AppError, db, notFound } from "../common/errors";
import { isUuid, parseBody, schemas } from "../common/validation";
import { AuthedRequest, SessionGuard } from "../auth/session.guard";

// Inventori: penerimaan (INV-01), buka karton (INV-05), tahan/lepas (INV-06), pindah status (COST-05).
// Peran, toko, dan aturan (stok negatif, kedaluwarsa, hak Owner) ditegakkan di database; controller hanya
// memvalidasi bentuk request dan mewajibkan Idempotency-Key.
function idemKey(key: string | undefined): string {
  if (!key || !isUuid(key)) throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "Header Idempotency-Key (UUID) wajib");
  return key.toLowerCase();
}

@Controller()
@UseGuards(SessionGuard)
export class InventoryController {
  constructor(@Inject(DbService) private readonly dbs: DbService) {}

  private async call(token: string, sql: string, params: unknown[]): Promise<Record<string, unknown>> {
    const r = await db(this.dbs.withActor(token, (c) => c.query<{ r: Record<string, unknown> }>(sql, params)));
    const res = r.rows[0].r;
    return { ...res, replayed: res.replayed === true };
  }

  @Post("inventory/receipts")
  @HttpCode(201)
  async receive(@Req() req: AuthedRequest, @Headers("idempotency-key") key: string | undefined, @Body() body: unknown) {
    const b = parseBody(schemas.inventoryReceipt, body);
    return this.call(req.sessionToken!, "select app.inventory_receive($1, $2::jsonb) as r", [idemKey(key), JSON.stringify(b)]);
  }

  @Post("packages/:id/open")
  @HttpCode(201)
  async open(@Req() req: AuthedRequest, @Param("id") id: string, @Headers("idempotency-key") key: string | undefined, @Body() body: unknown) {
    const b = parseBody(schemas.packageOpen, body);
    if (!isUuid(id)) throw notFound();
    return this.call(req.sessionToken!, "select app.package_open($1, $2, $3::jsonb) as r", [idemKey(key), id.toLowerCase(), JSON.stringify(b)]);
  }

  @Post("inventory/status-moves")
  @HttpCode(201)
  async move(@Req() req: AuthedRequest, @Headers("idempotency-key") key: string | undefined, @Body() body: unknown) {
    const b = parseBody(schemas.statusMove, body);
    return this.call(req.sessionToken!, "select app.stock_move($1, $2::jsonb) as r", [idemKey(key), JSON.stringify(b)]);
  }

  @Post("inventory/holds")
  @HttpCode(201)
  async hold(@Req() req: AuthedRequest, @Headers("idempotency-key") key: string | undefined, @Body() body: unknown) {
    const b = parseBody(schemas.stockHold, body);
    return this.call(req.sessionToken!, "select app.stock_hold($1, $2::jsonb) as r", [idemKey(key), JSON.stringify(b)]);
  }

  @Post("inventory/holds/:id/release")
  @HttpCode(200)
  async release(@Req() req: AuthedRequest, @Param("id") id: string, @Headers("idempotency-key") key: string | undefined, @Body() body: unknown) {
    const b = parseBody(schemas.holdRelease, body);
    if (!isUuid(id)) throw notFound();
    return this.call(req.sessionToken!, "select app.stock_release($1, $2, $3::jsonb) as r", [idemKey(key), id.toLowerCase(), JSON.stringify(b)]);
  }

  @Get("inventory/fefo")
  async fefo(@Req() req: AuthedRequest, @Query() query: unknown) {
    const q = parseBody(schemas.fefoQuery, query);
    const r = await db(this.dbs.withActor(req.sessionToken!, (c) =>
      c.query<{ r: unknown }>("select app.inventory_fefo($1, $2, $3, $4) as r",
        [q.productId, q.packageId ?? null, q.locationId ?? null, q.limit ?? 20])));
    return r.rows[0].r;
  }

  @Get("inventory/holds")
  async holds(@Req() req: AuthedRequest, @Query() query: unknown) {
    const q = parseBody(schemas.holdsQuery, query);
    const r = await db(
      this.dbs.withActor(req.sessionToken!, (c) => c.query<{ r: unknown }>("select app.hold_list($1) as r", [q.active !== "false"])),
    );
    return r.rows[0].r;
  }
}
