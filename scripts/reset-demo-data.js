import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const storePath = process.env.DATAIO_STORE_PATH
  ? path.resolve(process.env.DATAIO_STORE_PATH)
  : path.join(dataDir, "catalog.json");
const runtimeLogPath = process.env.DATAIO_RUNTIME_LOG_PATH
  ? path.resolve(process.env.DATAIO_RUNTIME_LOG_PATH)
  : path.join(rootDir, "logs", "runtime.log");

export function emptyStore() {
  return {
    connections: [],
    annotations: [],
    audits: [],
    schemaSnapshots: {},
    aiSettings: null,
    aiProfiles: [],
    activeAiProfileId: null,
  };
}

export async function resetDemoData() {
  await mkdir(path.dirname(storePath), { recursive: true });
  await mkdir(path.dirname(runtimeLogPath), { recursive: true });
  await writeFile(storePath, `${JSON.stringify(emptyStore(), null, 2)}\n`, "utf8");
  await writeFile(runtimeLogPath, "", "utf8");
  return { storePath, runtimeLogPath };
}

if (import.meta.url === `file://${process.argv[1].replaceAll("\\", "/")}`) {
  const result = await resetDemoData();
  console.log("DataIO demo data reset complete");
  console.log(`catalog=${result.storePath}`);
  console.log(`runtimeLog=${result.runtimeLogPath}`);
}
