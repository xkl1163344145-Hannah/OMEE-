import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../../src/db.mjs";
import { Domain } from "../../src/domain.mjs";
import { defaultScene } from "../../src/geometry.mjs";
const marker = "omee-isolated-qa-v1";
export function seedQa(directory) {
  const root = path.resolve(directory);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const markerFile = path.join(root, ".qa-environment"),
    accountsFile = path.join(root, "accounts.private.json"),
    fixtureFile = path.join(root, "fixtures.json");
  if (fs.existsSync(path.join(root, "app.sqlite"))) {
    if (
      fs.existsSync(markerFile) &&
      fs.readFileSync(markerFile, "utf8") === marker &&
      fs.existsSync(accountsFile) &&
      fs.existsSync(fixtureFile)
    )
      return { root, accountsFile, fixtureFile, reused: true };
    throw Error("拒绝改写已有数据库或未完成的种子数据；请使用新的空测试目录");
  }
  if (fs.readdirSync(root).length) throw Error("初始化只接受空目录");
  fs.writeFileSync(markerFile, marker, { mode: 0o600, flag: "wx" });
  const accounts = [
    ["qa_admin", "OMEE测试管理员"],
    ["qa_xadmin", "企业X管理员"],
    ["qa_yadmin", "企业Y管理员"],
    ["qa_designer", "跨企业设计师"],
    ["qa_departed", "已离职设计师"],
    ["qa_client", "客户"],
    ["qa_supplier_a", "桌椅供应商"],
    ["qa_supplier_b", "灯具供应商"],
    ["qa_outside", "无关用户"],
  ].map(([username, role]) => ({
    username,
    role,
    password: crypto.randomBytes(18).toString("base64url"),
  }));
  const s = new Store(path.join(root, "app.sqlite")),
    d = new Domain(s);
  let fixture;
  try {
    d.bootstrap(accounts[0].username, accounts[0].password);
    const admin = s.get("SELECT * FROM users WHERE username=?", "qa_admin");
    fixture = s.tx(() => {
      const users = { qa_admin: admin };
      for (const a of accounts.slice(1)) users[a.username] = d.user(admin, a);
      const x = d.workspace(users.qa_xadmin, "验收企业X"),
        y = d.workspace(users.qa_yadmin, "验收企业Y");
      for (const space of [x, y])
        for (const login of ["qa_designer", "qa_departed"]) {
          const i = d.invite(
            users[space.id === x.id ? "qa_xadmin" : "qa_yadmin"],
            space.id,
            { username: login, role: "designer" },
          );
          d.accept(users[login], i.id);
        }
      const supplierA = d.supplier(admin, {
          username: "qa_supplier_a",
          name: "验收桌椅供应商",
        }),
        supplierB = d.supplier(admin, {
          username: "qa_supplier_b",
          name: "验收灯具供应商",
        });
      const customer = d.customer(users.qa_xadmin, x.id, {
        username: "qa_client",
        name: "验收客户（虚构）",
      });
      const family = d.family(users.qa_xadmin, x.id, { name: "验收电竞家具" });
      const variants = [],
        offers = [];
      for (const [
        sku,
        name,
        width,
        depth,
        height,
        saleFen,
        costFen,
        supplierId,
      ] of [
        ["QA-DESK", "验收升降桌", 1400, 700, 750, 125000, 80000, supplierA.id],
        ["QA-CHAIR", "验收电竞椅", 600, 600, 1100, 80000, 45000, supplierA.id],
        ["QA-LIGHT", "验收吸顶灯", 500, 500, 100, 30000, 18000, supplierB.id],
      ]) {
        const v = d.variant(users.qa_xadmin, x.id, {
          familyId: family.id,
          sku,
          name,
          width,
          depth,
          height,
        });
        const o = d.offer(users.qa_xadmin, x.id, {
          variantId: v.id,
          supplierId,
          saleFen,
          costFen,
          stock: 100,
          validUntil: Date.now() + 30 * 86400e3,
        });
        variants.push(v);
        offers.push(o);
      }
      const scene = () => {
        const scene = defaultScene();
        scene.objects = [
          {
            id: "desk",
            roomId: "room-1",
            source: "new",
            variantId: variants[0].id,
            offerId: offers[0].id,
            x: 1200,
            y: 0,
            z: 700,
            width: 1400,
            depth: 700,
            height: 750,
            rotation: 0,
          },
          {
            id: "chair",
            roomId: "room-1",
            source: "new",
            variantId: variants[1].id,
            offerId: offers[1].id,
            x: 1200,
            y: 0,
            z: 1550,
            width: 600,
            depth: 600,
            height: 1100,
            rotation: 0,
          },
          {
            id: "light",
            roomId: "room-1",
            source: "new",
            variantId: variants[2].id,
            offerId: offers[2].id,
            x: 2500,
            y: 2700,
            z: 2000,
            width: 500,
            depth: 500,
            height: 100,
            rotation: 0,
          },
          {
            id: "existing-cabinet",
            roomId: "room-1",
            source: "existing",
            x: 3300,
            y: 0,
            z: 2800,
            width: 400,
            depth: 400,
            height: 800,
            rotation: 0,
          },
        ];
        return scene;
      };
      const projects = {},
        submissions = {};
      for (const [key, name] of [
        ["edit", "验收01·编辑保存"],
        ["self", "验收02·自购交付"],
        ["platform", "验收03·平台采购（付款关闭）"],
        ["supplier", "验收04·预置沙箱供货单（非真实交易）"],
      ]) {
        let p = d.createProject(users.qa_xadmin, x.id, {
          name,
          customerId: customer.id,
        });
        d.reassign(users.qa_xadmin, p.id, { designerId: users.qa_designer.id });
        p = d.save(users.qa_designer, p.id, {
          expectedVersion: p.version,
          scene: scene(),
        });
        projects[key] = p.id;
        if (key !== "edit")
          submissions[key] = d.submit(users.qa_designer, p.id, {
            expectedVersion: p.version,
          });
      }
      // Prebuilt sandbox records allow supplier review while all HTTP payment callbacks stay disabled.
      const supplierSubmission = submissions.supplier;
      for (const action of ["design", "bom"])
        d.review(users.qa_client, supplierSubmission.id, {
          action,
          hash: supplierSubmission.hash,
        });
      d.finalize(users.qa_designer, supplierSubmission.id);
      const supplierOrder = d.choose(users.qa_client, supplierSubmission.id, {
        choice: "platform",
      }).order;
      const event = {
        eventId: "qa-seeded-sandbox-payment",
        orderId: supplierOrder.id,
        amountFen: 235000,
        currency: "CNY",
      };
      d.payment("sandbox", event, JSON.stringify(event));
      const personal = d
        .me(users.qa_designer)
        .workspaces.find((w) => w.type === "personal");
      projects.personal = d.createProject(users.qa_designer, personal.id, {
        name: "同名项目·隔离验证",
      }).id;
      let yp = d.createProject(users.qa_yadmin, y.id, {
        name: "同名项目·隔离验证",
      });
      d.reassign(users.qa_yadmin, yp.id, { designerId: users.qa_designer.id });
      projects.y = yp.id;
      let dp = d.createProject(users.qa_xadmin, x.id, {
        name: "已离职成员的企业项目",
      });
      d.reassign(users.qa_xadmin, dp.id, { designerId: users.qa_departed.id });
      projects.departed = dp.id;
      d.revoke(users.qa_xadmin, x.id, users.qa_departed.id);
      return {
        environment: "isolated-qa",
        createdAt: new Date().toISOString(),
        paymentEnabled: false,
        seededSandboxPurchaseOrders: 2,
        workspaces: { x: x.id, y: y.id, personal: personal.id },
        projects,
        submissions,
        bomExpected: {
          lines: 3,
          quantity: 3,
          totalFen: 235000,
          currency: "CNY",
          existingExcluded: true,
        },
        notes: [
          "所有人物与商品均为测试数据",
          "SKU没有真实GLB，显示线框",
          "账号密码存本目录accounts.private.json，不得发布到GitHub",
          "30天报价到期后需新建验收数据集，不自动重置",
        ],
      };
    });
    fs.writeFileSync(
      accountsFile,
      JSON.stringify({ environment: "isolated-qa", accounts }, null, 2),
      { mode: 0o600, flag: "wx" },
    );
    fs.writeFileSync(fixtureFile, JSON.stringify(fixture, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    return { root, accountsFile, fixtureFile, reused: false };
  } finally {
    s.close();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target)
    throw Error("用法 node scripts/staging/seed.mjs <全新测试数据目录>");
  const r = seedQa(target);
  console.log(
    JSON.stringify({
      initialized: !r.reused,
      reused: r.reused,
      accountCount: 9,
      credentialsFile: r.accountsFile,
      fixturesFile: r.fixtureFile,
      passwordsPrinted: false,
    }),
  );
}
