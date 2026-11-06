import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Store } from "../src/db.mjs";
import { Domain, hash } from "../src/domain.mjs";
test("备份、散列校验与隔离目录恢复；损坏备份拒绝", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omee-backup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "data"),
    backup = path.join(root, "backup"),
    s = new Store(path.join(data, "app.sqlite")),
    d = new Domain(s);
  d.bootstrap("restoreadmin", "isolated-restore-password");
  const u = s.get("SELECT * FROM users"),
    w = d.me(u).workspaces[0],
    p = s.tx(() => d.createProject(u, w.id, { name: "恢复项目" }));
  const model = Buffer.from("isolated-backup-asset-fixture");
  fs.mkdirSync(path.join(data, "assets", "tmp", "unfinished"), {
    recursive: true,
  });
  fs.writeFileSync(path.join(data, "assets", "asset-fixture.glb"), model);
  fs.writeFileSync(
    path.join(data, "assets", "tmp", "unfinished", "0"),
    "incomplete upload",
  );
  s.run(
    "INSERT INTO assets VALUES(?,?,?,?,?,'stored_unverified','glb',?)",
    "asset-fixture",
    w.id,
    "备份样例",
    hash(model),
    model.length,
    u.id,
  );
  s.close();
  const run = (script, ...args) =>
    spawnSync(
      process.execPath,
      [path.resolve(import.meta.dirname, "../scripts", script), ...args],
      { encoding: "utf8" },
    );
  assert.equal(run("backup.mjs", data, backup).status, 0);
  assert.deepEqual(
    fs.readFileSync(path.join(backup, "assets", "asset-fixture.glb")),
    model,
  );
  assert.equal(fs.existsSync(path.join(backup, "assets", "tmp")), false);
  const checked = run("verify-backup.mjs", backup);
  assert.equal(checked.status, 0, checked.stderr);
  const restored = path.join(root, "restored");
  fs.mkdirSync(restored);
  fs.copyFileSync(
    path.join(backup, "app.sqlite"),
    path.join(restored, "app.sqlite"),
  );
  const s2 = new Store(path.join(restored, "app.sqlite"));
  assert.equal(
    s2.get("SELECT name FROM projects WHERE id=?", p.id).name,
    "恢复项目",
  );
  s2.close();
  fs.appendFileSync(path.join(backup, "app.sqlite"), "corrupt");
  assert.notEqual(run("verify-backup.mjs", backup).status, 0);
});
