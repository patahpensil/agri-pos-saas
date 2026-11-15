import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { AuthedRequest, SessionGuard } from "../auth/session.guard";
import { AppError, db, notFound } from "../common/errors";
import { isUuid, normalizePhone, parseBody } from "../common/validation";
import { DbService } from "../db/db.service";

const plainText = (max: number) => z.string().trim().min(1).max(max).refine((value) => !/\p{Cc}/u.test(value));
const customerBody = z.object({
  display_name: plainText(80),
  phone: z.string().max(20).transform((value, ctx) => {
    const normalized = normalizePhone(value);
    if (!normalized) ctx.addIssue({ code: "custom", message: "nomor HP tidak sah" });
    return normalized ?? "";
  }).nullable().optional(),
  address: plainText(200).nullable().optional(),
}).strict();

@Controller("customers")
@UseGuards(SessionGuard)
export class CustomerController {
  constructor(@Inject(DbService) private readonly dbs: DbService) {}

  @Post()
  async create(@Req() req: AuthedRequest, @Headers("idempotency-key") key: string | undefined, @Body() body: unknown) {
    if (!key || !isUuid(key)) throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "Header Idempotency-Key (UUID) wajib");
    const input = parseBody(customerBody, body);
    return this.query(req, "select app.customer_create($1,$2::jsonb) as result", [key.toLowerCase(), JSON.stringify(input)]);
  }

  @Get()
  async list(@Req() req: AuthedRequest, @Query("search") search: string | undefined) {
    const term = search?.trim();
    if (term !== undefined && (term.length > 80 || /\p{Cc}/u.test(term))) {
      throw new AppError(400, "VALIDATION_ERROR", "Data permintaan tidak sah", ["search"]);
    }
    return this.query(req, "select app.customer_list($1) as result", [term ? term : null]);
  }

  @Get(":id")
  async get(@Req() req: AuthedRequest, @Param("id") customerId: string) {
    if (!isUuid(customerId)) throw notFound();
    return this.query(req, "select app.customer_get($1) as result", [customerId.toLowerCase()]);
  }

  private query(req: AuthedRequest, sql: string, args: (string | null)[]) {
    return db(this.dbs.withActor(req.sessionToken!, async (client) => {
      await client.query("set local statement_timeout = '4s'");
      const result = await client.query<{ result: unknown }>(sql, args);
      return result.rows[0].result;
    }));
  }
}
