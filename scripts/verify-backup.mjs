import fs from "node:fs/promises";
import path from "node:path";
import { hashFile } from "./hash-file.mjs";
import { DatabaseSync } from "node:sqlite";
const dir = path.resolve(process.argv[2] || "");
const manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json")));
for (const f of manifest.files) {
  const p = path.resolve(dir, f.path);
  if (!p.startsWith(dir + path.sep)) throw Error("备份路径非法");
  const actual = await hashFile(p);
  if (actual.size !== f.size || actual.sha256 !== f.sha256)
    throw Error("文件损坏：" + f.path);
}
const db = new DatabaseSync(path.join(dir, "app.sqlite"), { readOnly: true });
try {
  if (
    db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" ||
    db.prepare("PRAGMA foreign_key_check").all().length
  )
    throw Error("数据库完整性检查失败");
  const assets = db.prepare("SELECT * FROM assets").all();
  for (const a of assets) {
    const actual = await hashFile(path.join(dir, "assets", a.id + ".glb"));
    if (actual.sha256 !== a.sha256 || actual.size !== a.size)
      throw Error("资产对账失败：" + a.id);
  }
  console.log("文件散列、SQLite完整性、外键及资产对账通过");
} finally {
  db.close();
}
