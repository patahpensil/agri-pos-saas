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
