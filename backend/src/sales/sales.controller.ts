import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { AuthedRequest, SessionGuard } from "../auth/session.guard";
import { AppError, db, notFound } from "../common/errors";
import { isUuid, parseBody } from "../common/validation";
import { DbService } from "../db/db.service";

const id = z.string().refine(isUuid).transform((value) => value.toLowerCase());
const amount = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
const line = z.object({
  product_id: id,
  package_version_id: id,
  batch_id: id,
  quantity: z.number().int().min(1).max(9_999_999),
}).strict();
// A bank, QRIS or EDC reference as printed on the proof. Optional; never trusted as proof by itself.
const reference = z.string().min(1).max(64)
  .refine((value) => value === value.trim() && !/\p{Cc}/u.test(value));
const cashPart = z.object({
  method: z.literal("CASH"),
  tendered_idr: amount,
  change_idr: amount,
  net_received_idr: amount,
}).strict();
const externalPart = z.object({
  method: z.enum(["TRANSFER", "QRIS", "EDC"]),
  net_received_idr: amount,
  reference: reference.nullable().optional(),
  proof_checked: z.boolean(),
}).strict();
const quoteBody = z.object({ lines: z.array(line).min(1).max(50) }).strict();
const payments = z.array(z.discriminatedUnion("method", [cashPart, externalPart])).max(4)
  .refine((parts) => parts.filter((part) => part.method === "CASH").length <= 1);
const saleBody = z.object({
  customer_id: id.nullable().optional(),
  due_on: z.iso.date().nullable().optional(),
  lines: z.array(line.extend({ quote_version: z.string().regex(/^[0-9a-f]{64}$/) })).min(1).max(50),
  payments,
}).strict();
const settlementBody = z.object({
  sale_id: id,
  expected_version: z.number().int().min(1).max(999_999_999),
  payments: payments.refine((parts) => parts.length > 0),
}).strict();

@Controller()
@UseGuards(SessionGuard)
export class SalesController {
  constructor(@Inject(DbService) private readonly dbs: DbService) {}

  @Post("sales/quote")
  @HttpCode(200)
  async quote(@Req() req: AuthedRequest, @Body() body: unknown) {
    const input = parseBody(quoteBody, body);
    return this.query(req, "select app.sale_quote($1::jsonb) as result", [JSON.stringify(input)]);
  }

  @Post("sales")
  async checkout(
    @Req() req: AuthedRequest,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: unknown,
  ) {
    if (!key || !isUuid(key)) throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "Header Idempotency-Key (UUID) wajib");
    const input = parseBody(saleBody, body);
    return this.query(req, "select app.sale_create($1,$2::jsonb) as result", [key.toLowerCase(), JSON.stringify(input)]);
  }

  @Get("sales/:id")
  async sale(@Req() req: AuthedRequest, @Param("id") saleId: string) {
    if (!isUuid(saleId)) throw notFound();
    return this.query(req, "select app.sale_get($1) as result", [saleId.toLowerCase()]);
  }

  @Post("payments")
  async settle(
    @Req() req: AuthedRequest,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: unknown,
  ) {
    if (!key || !isUuid(key)) throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "Header Idempotency-Key (UUID) wajib");
    const input = parseBody(settlementBody, body);
    return this.query(req, "select app.receivable_pay($1,$2::jsonb) as result", [key.toLowerCase(), JSON.stringify(input)]);
  }

  @Get("receivables")
  async receivables(@Req() req: AuthedRequest, @Query("customer_id") customerId: string | undefined) {
    if (customerId !== undefined && !isUuid(customerId)) throw new AppError(400, "VALIDATION_ERROR", "Data permintaan tidak sah", ["customer_id"]);
    return this.query(req, "select app.receivable_list($1) as result", [customerId?.toLowerCase() ?? null]);
  }

  @Get("operations/:key")
  async operation(@Req() req: AuthedRequest, @Param("key") key: string) {
    if (!isUuid(key)) throw notFound();
    return this.query(req, "select app.sale_operation($1) as result", [key.toLowerCase()]);
  }

  private async query(req: AuthedRequest, sql: string, args: (string | null)[]) {
    try {
      return await db(this.dbs.withActor(req.sessionToken!, async (client) => {
        await client.query("set local statement_timeout = '4s'");
        await client.query("set local lock_timeout = '3s'");
        const result = await client.query<{ result: unknown }>(sql, args);
        return result.rows[0].result;
      }));
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === "55P03" || code === "57014" || code === "40P01") {
        throw new AppError(409, "SALE_BUSY", "Transaksi belum dapat dikonfirmasi. Periksa status atau ulangi dengan kunci yang sama.");
      }
      throw error;
    }
  }
}
