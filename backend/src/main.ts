import { ConfigError, loadConfig } from "./config/config";
import { createApp } from "./app";
import { log } from "./common/log";

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  const { app, db } = await createApp(cfg);
  app.enableShutdownHooks();
  process.on("SIGTERM", () => void db.close());
  await app.listen(cfg.port);
  log({ level: "info", msg: "started", status: cfg.port });
}

main().catch((e: unknown) => {
  // Fail-closed: proses berhenti dengan kode != 0. Pesan konfigurasi tidak memuat nilai rahasia.
  if (e instanceof ConfigError) console.error(`STARTUP DITOLAK: ${e.message}`);
  else console.error("STARTUP GAGAL");
  process.exit(1);
});
