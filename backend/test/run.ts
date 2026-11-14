// Runner uji. TEST_SUITES: unit,config,db,aud,catalog,inv,pooler,api (dipisah koma). TEST_TARGET: direct | pgbouncer.
// Keluar dengan kode 1 bila ada FAIL. Hasil per ID ditulis ke TEST_RESULTS_DIR/results-<target>.json.
import { RESULTS, TARGET, closeAll, writeResults } from "./harness";
import { dbTests } from "./db.tests";
import { poolerTests } from "./pooler.tests";
import { apiTests } from "./api.tests";
import { audDbTests } from "./aud.tests";
import { catalogTests } from "./catalog.tests";
import { inventoryTests } from "./inventory.tests";
import { fefoTests } from "./fefo.tests";
import { stockCountTests } from "./stock-count.tests";
import { priceTests } from "./price.tests";
import { configTests, unitTests } from "./unit-config.tests";

async function main(): Promise<void> {
  const suites = (process.env.TEST_SUITES ?? "unit,config,db,aud,catalog,inv,fefo,count,price,pooler,api").split(",").map((s) => s.trim());
  console.log(`== target=${TARGET} suites=${suites.join(",")}`);
  if (suites.includes("unit")) await unitTests();
  if (suites.includes("db")) await dbTests();
  if (suites.includes("aud")) await audDbTests();
  if (suites.includes("catalog")) await catalogTests();
  if (suites.includes("inv")) await inventoryTests();
  if (suites.includes("fefo")) await fefoTests();
  if (suites.includes("count")) await stockCountTests();
  if (suites.includes("price")) await priceTests();
  if (suites.includes("pooler")) await poolerTests();
  if (suites.includes("api")) await apiTests();
  if (suites.includes("config")) await configTests();
  await closeAll();
  writeResults(process.env.TEST_RESULTS_DIR ?? "results");
  const pass = RESULTS.filter((r) => r.status === "PASS").length;
  const fail = RESULTS.filter((r) => r.status === "FAIL").length;
  const nt = RESULTS.filter((r) => r.status === "BELUM DIUJI").length;
  console.log(`\n== RINGKASAN [${TARGET}] PASS=${pass} FAIL=${fail} BELUM_DIUJI=${nt} TOTAL=${RESULTS.length}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("RUNNER ERROR", e);
  process.exit(1);
});
