import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Request } from "express";
import { unauthenticated } from "../common/errors";
import { TOKEN } from "../common/validation";

export interface AuthedRequest extends Request {
  sessionToken?: string;
}

// Guard hanya mengambil token Bearer. Keputusan siapa aktornya, tokonya, perannya, dan paketnya
// diambil DATABASE (iam.current_actor) di setiap panggilan fungsi, bukan di sini.
@Injectable()
export class SessionGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const h = req.headers.authorization;
    const m = typeof h === "string" ? /^Bearer ([0-9a-f]{64})$/.exec(h) : null;
    if (!m || !TOKEN.test(m[1])) throw unauthenticated();
    req.sessionToken = m[1];
    return true;
  }
}
