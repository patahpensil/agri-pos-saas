import { Controller, Get, HttpCode, Inject, Res } from "@nestjs/common";
import { Response } from "express";
import { DbService } from "../db/db.service";

// Tanpa detail database/versi di respons.
@Controller("health")
export class HealthController {
  constructor(@Inject(DbService) private readonly dbs: DbService) {}

  @Get("live")
  @HttpCode(200)
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(@Res() res: Response) {
    try {
      await this.dbs.auth.query("select 1");
      res.status(200).json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  }
}
