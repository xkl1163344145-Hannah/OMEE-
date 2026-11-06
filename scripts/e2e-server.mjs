import { createApp } from "../src/server.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omee-e2e-"));
const app = createApp({
  dataDir: dir,
  adminUsername: "e2eadmin",
  adminPassword: "isolated-e2e-password",
});
app.server.listen(3321, "127.0.0.1");
process.on("SIGTERM", () => {
  app.server.close(() => {
    app.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit();
  });
});
