import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedQa } from "../scripts/staging/seed.mjs";
import { Store } from "../src/db.mjs";
import { Domain } from "../src/domain.mjs";
import { createApp } from "../src/server.mjs";
test("独立验收：九角色、X/Y隔离、离职撤权、样例金额、供应商样例及安全重复初始化", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qa-fixture-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const info = seedQa(root),
    original = fs.readFileSync(info.accountsFile);
  assert.equal(seedQa(root).reused, true);
  assert.deepEqual(fs.readFileSync(info.accountsFile), original);
  assert.equal(fs.statSync(info.accountsFile).mode & 0o777, 0o600);
  const { accounts } = JSON.parse(original),
    f = JSON.parse(fs.readFileSync(info.fixtureFile)),
    s = new Store(path.join(root, "app.sqlite")),
    d = new Domain(s);
  try {
    assert.equal(accounts.length, 9);
    assert.equal(new Set(accounts.map((a) => a.password)).size, 9);
    const users = {};
    for (const a of accounts) {
      const token = s.tx(() => d.login(a));
      users[a.username] = d.auth(token);
    }
    assert.equal(d.me(users.qa_designer).workspaces.length, 3);
    assert.equal(d.me(users.qa_departed).workspaces.length, 2);
    assert.throws(
      () => d.project(users.qa_departed, f.projects.departed),
      (e) => e.status === 403,
    );
    assert.throws(
      () => d.project(users.qa_yadmin, f.projects.edit),
      (e) => e.status === 403,
    );
    assert.throws(
      () => d.project(users.qa_outside, f.projects.edit),
      (e) => e.status === 403,
    );
    const bom = d.bom(d.project(users.qa_designer, f.projects.edit));
    assert.equal(bom.totalFen, 235000);
    assert.equal(bom.lines.length, 3);
    assert.equal(d.purchases(users.qa_supplier_a).length, 1);
    assert.equal(d.purchases(users.qa_supplier_b).length, 1);
    assert.equal(d.purchases(users.qa_supplier_a)[0].lines.length, 2);
    assert.ok(
      !JSON.stringify(
        d.publicSubmission(users.qa_client, f.submissions.self.id),
      ).includes("costFen"),
    );
  } finally {
    s.close();
  }
});
test("非测试数据库与非空目录不会被种子脚本覆盖", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qa-refuse-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "app.sqlite"), "DO_NOT_TOUCH");
  assert.throws(() => seedQa(root), /拒绝改写/);
  assert.equal(
    fs.readFileSync(path.join(root, "app.sqlite"), "utf8"),
    "DO_NOT_TOUCH",
  );
});
test("验收网页显式标识隔离且付款回调禁用", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qa-http-"));
  seedQa(root);
  const app = createApp({ dataDir: root, environment: "isolated-qa" });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await new Promise((r) => app.server.close(r));
    app.store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + app.server.address().port,
    health = (await (await fetch(base + "/health")).json()).data;
  assert.equal(health.environment, "isolated-qa");
  assert.equal(health.sandboxPayments, false);
  assert.match(await (await fetch(base)).text(), /隔离验收环境/);
  assert.equal(
    (
      await fetch(base + "/api/v1/payment-webhooks/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    503,
  );
});
