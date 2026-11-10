import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Req, UseGuards } from "@nestjs/common";
import { DbService } from "../db/db.service";
import { AppError, db, notFound } from "../common/errors";
import { isUuid, parseBody, schemas } from "../common/validation";
import { AuthedRequest, SessionGuard } from "../auth/session.guard";

// Otorisasi, tenant, versi, dan reautentikasi harga diputuskan di database.
@Controller()
@UseGuards(SessionGuard)
export class PricingController {
  constructor(@Inject(DbService) private readonly dbs:DbService) {}
  private key(k:string|undefined):string {
    if(!k||!isUuid(k))throw new AppError(400,"IDEMPOTENCY_KEY_REQUIRED","Header Idempotency-Key (UUID) wajib");
    return k.toLowerCase();
  }
  @Post("price-change-requests")
  @HttpCode(201)
  async submit(@Req() req:AuthedRequest,@Headers("idempotency-key") key:string|undefined,@Body() body:unknown) {
    const b=parseBody(schemas.priceRequest,body);
    const r=await db(this.dbs.withActor(req.sessionToken!,c=>c.query<{r:Record<string,unknown>}>(
      "select app.price_submit($1,$2::jsonb) as r",[this.key(key),JSON.stringify(b)])));
    return r.rows[0].r;
  }
  @Post("price-change-requests/:id/approve")
  @HttpCode(200)
  async approve(@Req() req:AuthedRequest,@Param("id") id:string,
    @Headers("idempotency-key") key:string|undefined,@Body() body:unknown) {
    const b=parseBody(schemas.priceApprove,body);
    if(!isUuid(id))throw notFound();
    const r=await db(this.dbs.withActor(req.sessionToken!,c=>c.query<{r:Record<string,unknown>}>(
      "select app.price_approve($1,$2,$3::jsonb) as r",[this.key(key),id.toLowerCase(),JSON.stringify(b)])));
    return r.rows[0].r;
  }
  @Get("products/:id/prices")
  async prices(@Req() req:AuthedRequest,@Param("id") id:string) {
    if(!isUuid(id))throw notFound();
    const r=await db(this.dbs.withActor(req.sessionToken!,c=>c.query<{r:Record<string,unknown>}>(
      "select app.price_list($1) as r",[id.toLowerCase()])));
    return r.rows[0].r;
  }
}
