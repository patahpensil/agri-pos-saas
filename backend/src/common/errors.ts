// Error aplikasi yang aman ditampilkan ke klien. Semua error lain dipetakan ke 500 tanpa detail.
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly fields?: string[],
  ) {
    super(code);
  }
}

// Kode yang dilempar fungsi database (raise exception '<KODE>' using errcode = 'P0001').
const DB_CODES: Record<string, [number, string]> = {
  UNAUTHENTICATED: [401, "Sesi tidak sah atau sudah berakhir"],
  FORBIDDEN_ROLE: [403, "Peran Anda tidak berwenang untuk tindakan ini"],
  FEATURE_GATED_PLAN: [403, "Fitur tidak tersedia pada paket Anda"],
  TENANT_LOCKED: [403, "Masa paket berakhir; perubahan data dikunci"],
  NOT_FOUND: [404, "Data tidak ditemukan"],
  ADMIN_LIMIT_REACHED: [409, "Batas jumlah Admin untuk paket ini sudah tercapai"],
  PHONE_NOT_AVAILABLE: [409, "Nomor HP tidak dapat dipakai"],
  VALIDATION: [400, "Data permintaan tidak sah"],
  PASSWORD_POLICY: [400, "Kata sandi tidak memenuhi kebijakan"],
  // Katalog & stok awal
  SKU_DUPLICATE: [409, "SKU sudah dipakai di toko ini"],
  BARCODE_DUPLICATE: [409, "Barcode sudah dipakai di toko ini"],
  IDEMPOTENCY_PAYLOAD_MISMATCH: [409, "Idempotency-Key sudah dipakai untuk isi permintaan yang berbeda"],
  VERSION_CONFLICT: [409, "Data sudah diubah pihak lain; muat ulang lalu coba lagi"],
  PACKAGE_FACTOR_LOCKED: [409, "Faktor isi kemasan yang sudah punya histori stok tidak bisa diubah; buat varian baru"],
  PACKAGE_HAS_STOCK: [409, "Varian masih memiliki stok"],
  IMMUTABLE_FIELD: [409, "Field ini tidak bisa diubah"],
  LOCATION_INVALID: [400, "Lokasi tidak sah"],
  BATCH_EXPIRED: [400, "Batch sudah kedaluwarsa dan tidak bisa dicatat sebagai stok siap jual"],
  COST_BASIS_INVALID: [400, "Basis biaya stok awal tidak sah"],
  OPENING_REQUIRED: [400, "Stok awal wajib diisi (boleh 0)"],
  // Inventori
  PACKAGE_INVALID: [400, "Varian kemasan tidak sah untuk produk ini"],
  BATCH_INVALID: [400, "Batch tidak sah untuk produk ini"],
  PACKAGE_NOT_OPENABLE: [409, "Kemasan ini tidak boleh dibuka"],
  LOOSE_PACKAGE_REQUIRED: [409, "Pilih varian unit lepas yang aktif untuk hasil buka karton"],
  PHYSICAL_CONFIRMATION_REQUIRED: [400, "Konfirmasi fisik buka karton wajib"],
  INSUFFICIENT_STOCK: [409, "Stok tidak cukup"],
  HOLD_ACTIVE: [409, "Produk/batch sedang ditahan; stok tidak boleh masuk siap jual"],
  HOLD_NOT_ACTIVE: [409, "Penahanan sudah dilepas"],
  SUPPLIER_REQUIRED: [400, "Pemasok wajib diisi untuk setiap penerimaan stok"],
  BATCH_EXPIRY_MISMATCH: [409, "Nomor batch ini sudah tercatat dengan tanggal kedaluwarsa berbeda"],
  REAUTH_REQUIRED: [403, "Tindakan ini butuh konfirmasi ulang sandi Owner"],
  SUBSIDY_RECEIPT_SEPARATE: [409, "Pupuk subsidi wajib diterima lewat inventori subsidi, bukan Tambah Stok umum"],
  INVENTORY_INCONSISTENT: [409, "Saldo stok tidak konsisten; jalankan rekonsiliasi"],
};

export function fromDbError(e: unknown): AppError | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const err = e as { code?: string; message?: string };
  if (err.code !== "P0001" || typeof err.message !== "string") return undefined;
  const hit = DB_CODES[err.message];
  return hit ? new AppError(hit[0], err.message, hit[1]) : undefined;
}

// Bungkus panggilan DB: kode bisnis dikenal -> AppError; selain itu dilempar ulang (menjadi 500).
export async function db<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    const mapped = fromDbError(e);
    if (mapped) throw mapped;
    throw e;
  }
}

export const unauthenticated = () => new AppError(401, "UNAUTHENTICATED", "Sesi tidak sah atau sudah berakhir");
export const notFound = () => new AppError(404, "NOT_FOUND", "Data tidak ditemukan");
export const rateLimited = () => new AppError(429, "RATE_LIMITED", "Terlalu banyak percobaan. Coba lagi nanti");
