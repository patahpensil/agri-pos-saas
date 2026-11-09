import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { DbService } from "../db/db.service";
import { AppError, db, notFound } from "../common/errors";
import { isUuid, parseBody, schemas } from "../common/validation";
import { AuthedRequest, SessionGuard } from "../auth/session.guard";

// Master produk & stok awal (PRD-01..07). Toko, aktor, peran, dan status paket ditentukan database
// (iam.current_actor); body tidak pernah membawa tenant/role/plan/harga.
@Controller()
@UseGuards(SessionGuard)
export class CatalogController {
  constructor(@Inject(DbService) private readonly dbs: DbService) {}

  @Post("products")
  @HttpCode(201)
  async create(@Req() req: AuthedRequest, @Headers("idempotency-key") key: string | undefined, @Body() body: unknown) {
    const b = parseBody(schemas.productCreate, body);
    if (!key || !isUuid(key)) throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "Header Idempotency-Key (UUID) wajib");
    // Identitas permintaan idempoten dihitung database dari jsonb yang diterimanya (CAT-AUD-03).
    return db(
      this.dbs.withActor(req.sessionToken!, async (c) => {
        const r = await c.query<{ res: { productId: string; openingEventId: string; replayed?: boolean } }>(
          "select app.product_create($1, $2::jsonb) as res",
          [key.toLowerCase(), JSON.stringify(b)],
        );
        const res = r.rows[0].res;
        const p = await c.query<{ p: unknown }>("select app.product_get($1) as p", [res.productId]);
        return { ...res, replayed: res.replayed === true, product: p.rows[0].p };
      }),
    );
  }

  @Get("products")
  async list(@Req() req: AuthedRequest, @Query() query: unknown) {
    const q = parseBody(schemas.productListQuery, query);
    const r = await db(
      this.dbs.withActor(req.sessionToken!, (c) =>
        c.query<{ r: unknown }>("select app.product_list($1, $2, $3) as r", [q.search ?? null, q.limit ?? 50, q.offset ?? 0]),
      ),
    );
    return r.rows[0].r;
  }

  @Get("products/:id")
  async get(@Req() req: AuthedRequest, @Param("id") id: string) {
    if (!isUuid(id)) throw notFound();
    const r = await db(this.dbs.withActor(req.sessionToken!, (c) => c.query<{ p: unknown }>("select app.product_get($1) as p", [id])));
    return r.rows[0].p;
  }

  @Patch("products/:id")
  async patch(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown) {
    const b = parseBody(schemas.productPatch, body);
    if (!isUuid(id)) throw notFound();
    const { expectedVersion, ...patch } = b;
    const r = await db(
      this.dbs.withActor(req.sessionToken!, (c) =>
        c.query<{ p: unknown }>("select app.product_update($1, $2, $3::jsonb) as p", [id, expectedVersion, JSON.stringify(patch)]),
      ),
    );
    return r.rows[0].p;
  }

  // Proyeksi saldo; bukan sumber kebenaran checkout final.
  @Get("inventory/stock")
  async stock(@Req() req: AuthedRequest, @Query() query: unknown) {
    const q = parseBody(schemas.stockQuery, query);
    const r = await db(this.dbs.withActor(req.sessionToken!, (c) => c.query<{ s: unknown }>("select app.stock_list($1) as s", [q.productId ?? null])));
    return r.rows[0].s;
  }

  // INV-09: rekonsiliasi saldo vs ledger; ketidakcocokan dicatat sebagai alert tanpa mengubah histori.
  @Post("inventory/reconciliation")
  @HttpCode(200)
  async reconcile(@Req() req: AuthedRequest, @Body() body: unknown) {
    parseBody(schemas.empty, body);
    const r = await db(this.dbs.withActor(req.sessionToken!, (c) => c.query<{ r: unknown }>("select app.inventory_reconcile() as r")));
    return r.rows[0].r;
  }
}
