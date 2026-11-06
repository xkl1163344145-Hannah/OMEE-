import fs from "node:fs";
import path from "node:path";
import { createApp } from "../../src/server.mjs";
const root = path.resolve(process.env.QA_DATA_DIR || "");
if (
  !process.env.QA_DATA_DIR ||
  fs.readFileSync(path.join(root, ".qa-environment"), "utf8") !==
    "omee-isolated-qa-v1"
)
  throw Error("请先运行隔离验收初始化，QA_DATA_DIR必须指向测试数据目录");
if (process.env.SANDBOX_PAYMENT_SECRET)
  throw Error("人工验收实例禁止启用付款回调");
const app = createApp({
    dataDir: root,
    environment: "isolated-qa",
    revision: process.env.QA_REVISION || "unversioned-qa",
    secureCookies: process.env.QA_HTTPS === "true",
  }),
  port = Number(process.env.QA_PORT || 3301),
  host = process.env.QA_HOST || "127.0.0.1";
app.server.listen(port, host, () =>
  console.log(
    JSON.stringify({
      environment: "isolated-qa",
      host,
      port,
      paymentEnabled: false,
      dataDir: root,
      httpsCookies: process.env.QA_HTTPS === "true",
    }),
  ),
);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  app.server.close(() => {
    app.store.close();
    process.exit(0);
  });
  app.server.closeIdleConnections();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
