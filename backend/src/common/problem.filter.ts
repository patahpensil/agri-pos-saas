import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from "@nestjs/common";
import { Request, Response } from "express";
import { AppError, fromDbError } from "./errors";
import { log } from "./log";

// Semua error keluar sebagai application/problem+json. Error yang tidak dikenal -> 500 generik:
// tidak ada teks SQL, nama tabel, stack trace, atau rahasia di respons maupun log.
@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const correlationId = String(res.getHeader("X-Correlation-ID") ?? "");

    let err = exception instanceof AppError ? exception : fromDbError(exception);
    if (!err && exception instanceof HttpException) {
      const s = exception.getStatus();
      if (s === 404) err = new AppError(404, "NOT_FOUND", "Data tidak ditemukan");
      else if (s === 413) err = new AppError(413, "PAYLOAD_TOO_LARGE", "Ukuran permintaan terlalu besar");
      else if (s === 400) err = new AppError(400, "VALIDATION_ERROR", "Data permintaan tidak sah");
      else if (s === 415) err = new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Gunakan application/json");
    }
    if (!err && typeof exception === "object" && exception !== null) {
      // body-parser: JSON rusak / terlalu besar / tipe salah
      const t = (exception as { type?: string; status?: number }).type;
      if (t === "entity.parse.failed") err = new AppError(400, "VALIDATION_ERROR", "Data permintaan tidak sah");
      else if (t === "entity.too.large") err = new AppError(413, "PAYLOAD_TOO_LARGE", "Ukuran permintaan terlalu besar");
    }
    if (!err) {
      err = new AppError(500, "INTERNAL_ERROR", "Terjadi kesalahan pada server");
      log({ level: "error", msg: "unhandled", method: req.method, path: req.path, correlationId, code: "INTERNAL_ERROR" });
    }

    const body: Record<string, unknown> = {
      type: "about:blank",
      title: err.title,
      status: err.status,
      code: err.code,
      correlation_id: correlationId,
    };
    if (err.fields && err.fields.length) body.fields = err.fields;
    res.status(err.status).type("application/problem+json").send(JSON.stringify(body));
  }
}
