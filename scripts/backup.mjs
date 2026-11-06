import { DatabaseSync, backup } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import { hashFile } from "./hash-file.mjs";
const [source, target] = process.argv.slice(2);
if (!source || !target)
  throw Error("用法 node scripts/backup.mjs <data目录> <不存在的备份目录>");
const src = path.resolve(source),
  dest = path.resolve(target);
if (dest === src || dest.startsWith(src + path.sep))
  throw Error("备份目录必须在数据目录外");
await fs.mkdir(dest, { recursive: false, mode: 0o700 });
const db = new DatabaseSync(path.join(src, "app.sqlite"), { readOnly: true });
try {
  await backup(db, path.join(dest, "app.sqlite"));
  await fs
    .cp(path.join(src, "assets"), path.join(dest, "assets"), {
      recursive: true,
      filter: (p) => {
        const relative = path.relative(path.join(src, "assets"), p);
        return (
          relative.split(path.sep)[0] !== "tmp" && !p.endsWith(".assembling")
        );
      },
    })
    .catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  const files = [];
  async function walk(dir) {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, item.name);
      if (item.isDirectory()) await walk(p);
      else {
        if (item.isSymbolicLink()) throw Error("备份中不允许符号链接");
        files.push({ path: path.relative(dest, p), ...(await hashFile(p)) });
      }
    }
  }
  await walk(dest);
  await fs.writeFile(
    path.join(dest, "manifest.json"),
    JSON.stringify({ createdAt: new Date().toISOString(), files }, null, 2),
  );
  console.log("备份完成，请执行verify-backup校验，并在隔离目录恢复演练");
} finally {
  db.close();
}
