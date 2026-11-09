import { z } from "zod";
import { AppError } from "./errors";

// Normalisasi nomor HP Indonesia ke E.164 (+62...). Nilai tidak sah -> null.
export function normalizePhone(raw: string): string | null {
  const s = raw.replace(/[\s-]/g, "");
  let digits: string;
  if (/^\+62[0-9]+$/.test(s)) digits = s.slice(3);
  else if (/^62[0-9]+$/.test(s)) digits = s.slice(2);
  else if (/^0[0-9]+$/.test(s)) digits = s.slice(1);
  else return null;
  if (!/^[1-9][0-9]{7,12}$/.test(digits)) return null;
  return "+62" + digits;
}

const phone = z
  .string()
  .max(20)
  .transform((v, ctx) => {
    const n = normalizePhone(v);
    if (n === null) {
      ctx.addIssue({ code: "custom", message: "nomor HP tidak sah" });
      return z.NEVER;
    }
    return n;
  });

const deviceId = z.string().regex(/^[A-Za-z0-9._-]{8,128}$/);
const otpCode = z.string().regex(/^[0-9]{6}$/);
// Panjang minimum sandi ditegakkan database (parameter password_min_length); di sini hanya batas kasar.
const password = z.string().min(1).max(72);

const barcode = z.string().regex(/^[0-9A-Za-z-]{4,64}$/);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i).transform((v) => v.toLowerCase());
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => !Number.isNaN(Date.parse(v + "T00:00:00Z")) && new Date(v + "T00:00:00Z").toISOString().startsWith(v), "tanggal tidak sah");
const rupiah = z.number().int().min(0).max(1_000_000_000_000_000);
const packageForm = z
  .object({
    key: z.string().regex(/^[a-z0-9_-]{1,30}$/),
    form: z.enum(["SEALED", "LOOSE"]),
    factor: z.number().int().min(1).max(1_000_000),
    label: z.string().trim().min(1).max(60),
    barcode: barcode.optional(),
    mayOpen: z.boolean().optional(),
  })
  .strict()
  .refine((p) => p.form === "SEALED" || (p.factor === 1 && p.mayOpen !== true), "unit lepas wajib faktor 1 dan tidak bisa dibuka");
const openingLine = z
  .object({
    packageKey: z.string().regex(/^[a-z0-9_-]{1,30}$/),
    qty: z.number().int().min(0).max(10_000_000),
    batch: z.object({ number: z.string().trim().min(1).max(64).optional(), expiresOn: isoDate.optional() }).strict().optional(),
    cost: z
      .object({
        basis: z.enum(["KNOWN", "BONUS_ZERO", "UNVERIFIED"]),
        totalIdr: rupiah.optional(),
        reason: z.string().trim().min(1).max(200).optional(),
        origin: z.string().trim().min(1).max(200).optional(),
      })
      .strict(),
  })
  .strict();
const packageAdd = z
  .object({
    form: z.enum(["SEALED", "LOOSE"]),
    factor: z.number().int().min(1).max(1_000_000),
    label: z.string().trim().min(1).max(60),
    barcode: barcode.optional(),
    mayOpen: z.boolean().optional(),
    supersedesId: uuid.optional(),
  })
  .strict()
  .refine((p) => p.form === "SEALED" || (p.factor === 1 && p.mayOpen !== true), "unit lepas wajib faktor 1 dan tidak bisa dibuka");
const packageUpdate = z
  .object({
    id: uuid,
    label: z.string().trim().min(1).max(60).optional(),
    factor: z.number().int().min(1).max(1_000_000).optional(),
    barcode: barcode.nullable().optional(),
    mayOpen: z.boolean().optional(),
  })
  .strict();

const stockStatus = z.enum(["SALEABLE", "INSPECTION", "HELD", "DAMAGED", "QUARANTINE"]);
const reason = z.string().trim().min(1).max(200);
const receiptLine = z
  .object({
    packageId: uuid,
    qty: z.number().int().min(1).max(10_000_000),
    status: stockStatus,
    batch: z.object({ number: z.string().trim().min(1).max(64).optional(), expiresOn: isoDate.optional() }).strict().optional(),
    cost: z
      .object({
        basis: z.enum(["KNOWN", "BONUS_ZERO", "UNVERIFIED"]),
        totalIdr: rupiah.optional(),
        reason: z.string().trim().min(1).max(200).optional(),
        origin: z.string().trim().min(1).max(200).optional(),
      })
      .strict(),
  })
  .strict();

// .strict(): field asing ditolak (termasuk tenant_id, role, plan). Tidak ada objek bersarang yang sah,
// jadi objek/array di posisi mana pun juga ditolak oleh tipe field.
export const schemas = {
  registerStart: z.object({ phone }).strict(),
  registerVerify: z
    .object({
      phone,
      code: otpCode,
      password,
      businessName: z.string().trim().min(1).max(120),
      timezone: z.enum(["Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura"]),
      deviceId,
    })
    .strict(),
  login: z.object({ phone, password, deviceId }).strict(),
  activateAdmin: z.object({ phone, code: otpCode, password, deviceId }).strict(),
  activationStart: z.object({ phone }).strict(),
  staffInvite: z.object({ phone, displayName: z.string().trim().min(1).max(80) }).strict(),
  empty: z.object({}).strict(),
  // Harga jual sengaja TIDAK diterima di sini (K-2: Admin mengajukan, Owner menyetujui; modul harga terpisah).
  productCreate: z
    .object({
      sku: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/),
      name: z.string().trim().min(1).max(120),
      category: z.enum(["FERTILIZER", "PESTICIDE", "TOOL"]),
      subsidized: z.boolean(),
      brand: z.string().trim().min(1).max(80).optional(),
      baseUnit: z.string().trim().min(1).max(20),
      barcode: barcode.optional(),
      locationId: uuid.optional(),
      packages: z.array(packageForm).min(1).max(20),
      opening: z.array(openingLine).min(1).max(100),
    })
    .strict()
    .refine((p) => !p.subsidized || p.category === "FERTILIZER", "hanya pupuk yang bisa bersubsidi"),
  productPatch: z
    .object({
      expectedVersion: z.number().int().min(1),
      name: z.string().trim().min(1).max(120).optional(),
      brand: z.string().trim().min(1).max(80).nullable().optional(),
      category: z.enum(["FERTILIZER", "PESTICIDE", "TOOL"]).optional(),
      active: z.boolean().optional(),
      barcode: barcode.nullable().optional(),
      packages: z
        .object({
          add: z.array(packageAdd).max(20).optional(),
          update: z.array(packageUpdate).max(20).optional(),
          retire: z.array(uuid).max(20).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  productListQuery: z
    .object({
      search: z.string().trim().min(1).max(60).optional(),
      limit: z.string().regex(/^[0-9]{1,3}$/).transform(Number).refine((n) => n >= 1 && n <= 200).optional(),
      offset: z.string().regex(/^[0-9]{1,6}$/).transform(Number).optional(),
    })
    .strict(),
  stockQuery: z.object({ productId: uuid.optional() }).strict(),
  fefoQuery: z.object({
    productId: uuid,
    packageId: uuid.optional(),
    locationId: uuid.optional(),
    limit: z.string().regex(/^[0-9]{1,2}$/).transform(Number).refine((n) => n >= 1 && n <= 50).optional(),
  }).strict(),
  // INV-07: opname terstruktur PRO untuk barang siap jual, per batch dan kemasan.
  // Waktu countedAt hanya mengidentifikasi waktu hitung fisik; posting baru terjadi setelah Owner setuju.
  stockCount: z.object({
    productId: uuid,
    locationId: uuid.optional(),
    countedAt: z.string().datetime({ offset: true }),
    reason,
    lines: z.array(z.object({
      packageId: uuid,
      batchId: uuid,
      physicalQty: z.number().int().min(0).max(10_000_000),
      cost: z.object({
        basis: z.enum(["KNOWN", "BONUS_ZERO", "UNVERIFIED"]),
        totalIdr: rupiah.optional(),
        reason: z.string().trim().min(1).max(200).optional(),
        origin: z.string().trim().min(1).max(200).optional(),
      }).strict().optional(),
    }).strict()).min(1).max(100).superRefine((lines, ctx) => {
      const seen = new Set<string>();
      lines.forEach((line, index) => {
        const key = line.packageId + "/" + line.batchId;
        if (seen.has(key)) ctx.addIssue({ code: "custom", path: [index], message: "duplikat kemasan dan batch" });
        seen.add(key);
      });
    }),
  }).strict(),
  stockCountApprove: z.object({
    expectedVersion: z.number().int().min(1).max(2147483647),
    reason,
    referenceDocument: z.string().trim().min(1).max(120).optional(),
    reauthToken: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
  // Inventori (INV-01/05/06). Tidak ada field tenant/role/aktor; database menurunkannya dari sesi.
  inventoryReceipt: z
    .object({
      productId: uuid,
      locationId: uuid.optional(),
      supplierName: z.string().trim().min(1).max(120),
      sourceDocument: z.string().trim().min(1).max(80).optional(),
      lines: z.array(receiptLine).min(1).max(100),
    })
    .strict(),
  packageOpen: z
    .object({
      batchId: uuid,
      qty: z.number().int().min(1).max(10_000).optional(),
      status: stockStatus.optional(),
      loosePackageId: uuid.optional(),
      locationId: uuid.optional(),
      physicalConfirmed: z.boolean(),
    })
    .strict(),
  statusMove: z
    .object({
      productId: uuid,
      locationId: uuid.optional(),
      packageId: uuid,
      batchId: uuid,
      from: stockStatus,
      to: stockStatus,
      qty: z.number().int().min(1).max(10_000_000),
      reason,
      referenceDocument: z.string().trim().min(1).max(120).optional(),
      reauthToken: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    })
    .strict(),
  stockHold: z.object({ productId: uuid, batchId: uuid.optional(), locationId: uuid.optional(), reason }).strict(),
  holdRelease: z.object({ reason, reauthToken: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict(),
  // Reautentikasi Owner untuk satu aksi sensitif pada satu objek (AUTH-04).
  // inventory.move: isi perpindahan yang disetujui ikut diikat ke token (INV-AUD-04); targetId = batchId.
  reauth: z
    .object({
      password,
      action: z.enum(["inventory.release", "inventory.move", "inventory.count.approve"]),
      targetId: uuid,
      scope: z
        .object({
          productId: uuid, packageId: uuid, batchId: uuid, locationId: uuid.optional(),
          from: z.enum(["INSPECTION", "QUARANTINE"]), to: z.literal("SALEABLE"), qty: z.number().int().min(1).max(10_000_000),
        }).strict()
        .or(z.object({ expectedVersion: z.number().int().min(1).max(2147483647) }).strict())
        .optional(),
    })
    .strict()
    .refine((r) =>
      (r.action === "inventory.release" && r.scope === undefined)
      || (r.action === "inventory.move" && !!r.scope && "productId" in r.scope)
      || (r.action === "inventory.count.approve" && !!r.scope && "expectedVersion" in r.scope),
      "scope harus sesuai aksi reautentikasi"),
  holdsQuery: z.object({ active: z.enum(["true", "false"]).optional() }).strict(),
};


export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    const fields: string[] = [];
    for (const i of r.error.issues) {
      const base = i.path.length ? i.path.join(".") : "";
      // Untuk key asing, zod menaruh nama key di issue.keys.
      if (i.code === "unrecognized_keys") for (const k of i.keys) fields.push(base ? `${base}.${String(k)}` : String(k));
      else fields.push(base || "(body)");
    }
    throw new AppError(400, "VALIDATION_ERROR", "Data permintaan tidak sah", [...new Set(fields)].slice(0, 20));
  }
  return r.data;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID.test(s);
export const TOKEN = /^[0-9a-f]{64}$/;
