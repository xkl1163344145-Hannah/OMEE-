import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/db.mjs";
import { Domain, hash } from "../src/domain.mjs";
import { Assets } from "../src/assets.mjs";
import { defaultScene, validateScene } from "../src/geometry.mjs";
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omee-")),
    s = new Store(path.join(dir, "app.sqlite")),
    d = new Domain(s);
  t.after(() => {
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  d.bootstrap("rootadmin", "test-password-123");
  const admin = s.get("SELECT * FROM users");
  const create = (n) =>
    s.tx(() => d.user(admin, { username: n, password: "test-password-123" }));
  const designer = create("designer"),
    client = create("customer"),
    supplier = create("supplier"),
    other = create("another");
  const w = s.tx(() => d.workspace(admin, "企业X")).id;
  const inv = s.tx(() =>
    d.invite(admin, w, { username: "designer", role: "designer" }),
  );
  s.tx(() => d.accept(designer, inv.id));
  const c = s.tx(() =>
    d.customer(admin, w, { username: "customer", name: "客户C" }),
  );
  const p = s.tx(() =>
    d.createProject(admin, w, { name: "电竞房", customerId: c.id }),
  );
  s.tx(() => d.reassign(admin, p.id, { designerId: designer.id }));
  const f = s.tx(() => d.family(admin, w, { name: "桌子" }));
  const v = s.tx(() =>
    d.variant(admin, w, {
      familyId: f.id,
      sku: "DESK-01",
      name: "升降桌",
      width: 1400,
      depth: 700,
      height: 750,
    }),
  );
  const sup = s.tx(() =>
    d.supplier(admin, { username: "supplier", name: "供货商" }),
  );
  const offer = s.tx(() =>
    d.offer(admin, w, {
      variantId: v.id,
      supplierId: sup.id,
      saleFen: 199900,
      costFen: 120000,
      stock: 50,
      validUntil: Date.now() + 86400e3,
    }),
  );
  const scene = defaultScene();
  scene.objects.push({
    id: "desk1",
    roomId: "room-1",
    source: "new",
    variantId: v.id,
    offerId: offer.id,
    x: 1200,
    y: 0,
    z: 1000,
    width: 1400,
    depth: 700,
    height: 750,
    rotation: 0,
  });
  const saved = s.tx(() =>
    d.save(designer, p.id, { expectedVersion: 1, scene }),
  );
  return {
    dir,
    s,
    d,
    admin,
    designer,
    client,
    supplier,
    other,
    w,
    p: saved,
    v,
    offer,
    scene,
  };
}
const fault = (fn, code) => assert.throws(fn, (e) => e.code === code);
const submit = (x) =>
  x.s.tx(() =>
    x.d.submit(x.designer, x.p.id, { expectedVersion: x.p.version }),
  );
function final(x) {
  const a = submit(x);
  for (const action of ["design", "bom"])
    x.s.tx(() => x.d.review(x.client, a.id, { action, hash: a.hash }));
  x.s.tx(() => x.d.finalize(x.designer, a.id));
  return a;
}
test("租户隔离、项目分配、离职撤权且保留个人空间", (t) => {
  const x = fixture(t),
    { d, s, admin, designer, other, w, p } = x;
  fault(() => d.project(other, p.id), "WORKSPACE_FORBIDDEN");
  const b = s.tx(() => d.workspace(admin, "企业Y"));
  const i = s.tx(() =>
    d.invite(admin, b.id, { username: "designer", role: "designer" }),
  );
  s.tx(() => d.accept(designer, i.id));
  const unassigned = s.tx(() => d.createProject(admin, w, { name: "未分配" }));
  fault(() => d.project(designer, unassigned.id), "PROJECT_FORBIDDEN");
  s.tx(() => d.revoke(admin, w, designer.id));
  fault(() => d.project(designer, p.id), "WORKSPACE_FORBIDDEN");
  assert.equal(d.me(designer).workspaces.length, 2);
});
test("BOM可信价格、成本脱敏、外人不可审阅", (t) => {
  const x = fixture(t);
  assert.equal(x.d.bom(x.p).totalFen, 199900);
  assert.ok(!JSON.stringify(x.d.catalog(x.designer, x.w)).includes("cost_fen"));
  const a = submit(x),
    pub = x.d.publicSubmission(x.client, a.id);
  assert.ok(!JSON.stringify(pub).includes("costFen"));
  assert.ok(!JSON.stringify(pub).includes("supplierId"));
  fault(() => x.d.publicSubmission(x.other, a.id), "WORKSPACE_FORBIDDEN");
});
test("乐观锁、不可变快照、双确认、哈希、自购无商品订单", (t) => {
  const x = fixture(t),
    { s, d, designer, p, scene, client } = x;
  fault(
    () => s.tx(() => d.save(designer, p.id, { expectedVersion: 1, scene })),
    "VERSION",
  );
  const a = submit(x);
  fault(
    () => s.tx(() => d.save(designer, p.id, { expectedVersion: 2, scene })),
    "LOCKED",
  );
  fault(
    () =>
      s.tx(() => d.review(client, a.id, { action: "design", hash: "wrong" })),
    "HASH",
  );
  s.tx(() => d.review(client, a.id, { action: "design", hash: a.hash }));
  fault(() => s.tx(() => d.finalize(designer, a.id)), "STATE");
  s.tx(() => d.review(client, a.id, { action: "bom", hash: a.hash }));
  s.tx(() => d.finalize(designer, a.id));
  s.tx(() => d.choose(client, a.id, { choice: "self" }));
  assert.equal(s.get("SELECT count(*) n FROM sales_orders").n, 0);
  assert.equal(s.get("SELECT count(*) n FROM purchase_orders").n, 0);
  assert.throws(
    () => s.run("UPDATE submissions SET payload=? WHERE id=?", "{}", a.id),
    /immutable/,
  );
  const before = d.publicSubmission(client, a.id);
  s.tx(() => d.fork(designer, p.id, { expectedVersion: 2 }));
  assert.deepEqual(d.publicSubmission(client, a.id), before);
});
test("100次同一付款及不同事件重复通知只拆一组采购单", (t) => {
  const x = fixture(t),
    a = final(x),
    { s, d, client } = x;
  const o = s.tx(() => d.choose(client, a.id, { choice: "platform" })).order;
  const event = {
      eventId: "paid-1",
      orderId: o.id,
      amountFen: 199900,
      currency: "CNY",
    },
    raw = JSON.stringify(event);
  for (let i = 0; i < 100; i++) s.tx(() => d.payment("sandbox", event, raw));
  const e2 = { ...event, eventId: "paid-2" };
  s.tx(() => d.payment("sandbox", e2, JSON.stringify(e2)));
  assert.equal(s.get("SELECT count(*) n FROM purchase_orders").n, 1);
  assert.equal(s.get("SELECT stock FROM offers").stock, 49);
  assert.equal(d.purchases(x.other).length, 0);
  assert.equal(d.purchases(x.supplier).length, 1);
  assert.ok(!JSON.stringify(d.purchases(x.supplier)).includes("unitPriceFen"));
  fault(
    () =>
      s.tx(() => d.payment("sandbox", { ...event, amountFen: 1 }, "changed")),
    "PAYMENT_EVENT",
  );
});
test("金额错误或过期报价使付款事务回滚", (t) => {
  const x = fixture(t),
    a = final(x),
    { s, d, client } = x,
    o = s.tx(() => d.choose(client, a.id, { choice: "platform" })).order;
  fault(
    () =>
      s.tx(() =>
        d.payment(
          "sandbox",
          { eventId: "bad", orderId: o.id, amountFen: 1, currency: "CNY" },
          "bad",
        ),
      ),
    "PAYMENT_AMOUNT",
  );
  assert.equal(s.get("SELECT count(*) n FROM payment_events").n, 0);
  s.run("UPDATE offers SET valid_until=0");
  fault(
    () =>
      s.tx(() =>
        d.payment(
          "sandbox",
          {
            eventId: "good",
            orderId: o.id,
            amountFen: 199900,
            currency: "CNY",
          },
          "good",
        ),
      ),
    "REQUOTE",
  );
  assert.equal(s.get("SELECT count(*) n FROM purchase_orders").n, 0);
});
test("退回修订不改历史；跨租户SKU、非等比变形拒绝", (t) => {
  const x = fixture(t),
    a = submit(x),
    { s, d, client, p, scene, designer } = x;
  s.tx(() => d.review(client, a.id, { action: "changes", hash: a.hash }));
  scene.objects[0].width = 1500;
  fault(
    () => s.tx(() => d.save(designer, p.id, { expectedVersion: 2, scene })),
    "SKU_DIMENSIONS",
  );
  scene.objects[0].width = 1400;
  scene.objects[0].variantId = "other";
  fault(
    () => s.tx(() => d.save(designer, p.id, { expectedVersion: 2, scene })),
    "SKU",
  );
  assert.equal(d.publicSubmission(client, a.id).state, "changes_requested");
});
test("GLB散列、原件权限、重复完成及重启恢复", async (t) => {
  const x = fixture(t),
    a = new Assets(x.d, path.join(x.dir, "assets"));
  const js = Buffer.from(
      JSON.stringify({ asset: { version: "2.0" }, scenes: [{}] }),
    ),
    padded = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 32)]),
    b = Buffer.alloc(20 + padded.length);
  b.write("glTF");
  b.writeUInt32LE(2, 4);
  b.writeUInt32LE(b.length, 8);
  b.writeUInt32LE(padded.length, 12);
  b.write("JSON", 16);
  padded.copy(b, 20);
  const up = await a.init(x.admin, x.w, {
    name: "模型.glb",
    size: b.length,
    sha256: hash(b),
    parts: 1,
  });
  await a.part(x.admin, up.id, 0, b);
  await a.complete(x.admin, up.id);
  assert.deepEqual(fs.readFileSync(a.raw(x.admin, up.id)), b);
  fault(() => a.raw(x.designer, up.id), "FORBIDDEN");
  assert.equal((await a.complete(x.admin, up.id)).id, up.id);
  const s2 = new Store(path.join(x.dir, "app.sqlite"));
  assert.equal(s2.get("SELECT sha256 FROM assets").sha256, hash(b));
  s2.close();
});
test("几何校验：自交、门窗超墙", () => {
  const s = defaultScene();
  assert.deepEqual(validateScene(s), []);
  s.rooms[0].points = [
    { x: 0, z: 0 },
    { x: 4000, z: 3500 },
    { x: 4000, z: 0 },
    { x: 0, z: 3500 },
  ];
  assert.ok(validateScene(s).some((e) => e.code === "SELF_INTERSECTION"));
  const d = defaultScene();
  d.rooms[0].openings.push({
    id: "door",
    kind: "door",
    wallId: "w1",
    offset: 3800,
    width: 800,
    height: 2100,
    sill: 0,
  });
  assert.ok(validateScene(d).some((e) => e.code === "OPENING"));
});

test("两供应商按主体拆单；原有家具不采购；回调重放不重拆", (t) => {
  const x = fixture(t),
    { s, d, admin, designer, supplier, p, scene, w } = x;
  const sup2 = s.tx(() =>
    d.supplier(admin, { username: "another", name: "第二供应商" }),
  );
  const f = s.tx(() => d.family(admin, w, { name: "第二系列" }));
  const v = s.tx(() =>
    d.variant(admin, w, {
      familyId: f.id,
      sku: "CAB-02",
      name: "柜子",
      width: 500,
      depth: 500,
      height: 1000,
    }),
  );
  const offer = s.tx(() =>
    d.offer(admin, w, {
      variantId: v.id,
      supplierId: sup2.id,
      saleFen: 50000,
      costFen: 30000,
      stock: 10,
      validUntil: Date.now() + 86400e3,
    }),
  );
  scene.objects.push(
    {
      id: "cabinet",
      roomId: "room-1",
      source: "new",
      variantId: v.id,
      offerId: offer.id,
      x: 3000,
      y: 0,
      z: 2000,
      width: 500,
      depth: 500,
      height: 1000,
      rotation: 0,
    },
    {
      id: "existing-desk",
      roomId: "room-1",
      source: "existing",
      x: 1000,
      y: 0,
      z: 2700,
      width: 500,
      depth: 500,
      height: 500,
      rotation: 0,
    },
  );
  x.p = s.tx(() => d.save(designer, p.id, { expectedVersion: 2, scene }));
  const a = final(x),
    o = s.tx(() => d.choose(x.client, a.id, { choice: "platform" })).order,
    event = {
      eventId: "multi",
      orderId: o.id,
      amountFen: 249900,
      currency: "CNY",
    },
    raw = JSON.stringify(event);
  for (let i = 0; i < 100; i++) s.tx(() => d.payment("sandbox", event, raw));
  assert.equal(s.get("SELECT count(*) n FROM purchase_orders").n, 2);
  assert.equal(d.purchases(supplier)[0].lines[0].sku, "DESK-01");
  assert.equal(d.purchases(x.other)[0].lines[0].sku, "CAB-02");
  assert.equal(
    JSON.parse(s.get("SELECT lines FROM sales_orders").lines).length,
    2,
  );
});

test("恶意空几何字段返回校验错误而非崩溃", () => {
  for (const bad of [
    { ...defaultScene(), rooms: [null] },
    { ...defaultScene(), objects: [null] },
    {
      ...defaultScene(),
      rooms: [{ ...defaultScene().rooms[0], points: [null, null, null] }],
    },
    {
      ...defaultScene(),
      rooms: [{ ...defaultScene().rooms[0], openings: [null] }],
    },
  ])
    assert.ok(validateScene(bad).length > 0);
});
