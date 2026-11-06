// Read-only legacy inventory. Never imports executable JS, overwrites files or guesses ownership.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
const root = path.resolve(process.argv[2] || "");
if (!process.argv[2])
  throw Error("用法 node scripts/inventory.mjs <旧数据目录> > inventory.json");
const entries = [];
async function walk(dir) {
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, item.name);
    if (item.isSymbolicLink()) {
      entries.push({ path: path.relative(root, p), status: "symlink_skipped" });
      continue;
    }
    if (item.isDirectory()) await walk(p);
    else {
      const data = await fs.readFile(p);
      const row = {
        path: path.relative(root, p),
        size: data.length,
        sha256: crypto.createHash("sha256").update(data).digest("hex"),
      };
      if (item.name.endsWith(".json")) {
        try {
          const j = JSON.parse(data);
          row.shape = Array.isArray(j)
            ? { kind: "array", length: j.length }
            : { kind: typeof j, keys: Object.keys(j || {}) };
          row.migration = "manual_owner_and_unit_review_required";
        } catch {
          row.migration = "invalid_json";
        }
      }
      entries.push(row);
    }
  }
}
await walk(root);
console.log(
  JSON.stringify(
    { root, generatedAt: new Date().toISOString(), readOnly: true, entries },
    null,
    2,
  ),
);
