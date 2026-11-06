import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Store } from "./db.mjs";
import { Domain, Fault, fail, hash, uid } from "./domain.mjs";
import { Assets } from "./assets.mjs";
const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function createApp({
  dataDir = path.join(base, "data"),
  adminUsername,
  adminPassword,
  sandboxSecret,
  secureCookies = false,
  environment = "development",
  revision = "workspace",
} = {}) {
  const store = new Store(path.join(dataDir, "app.sqlite")),
    d = new Domain(store),
    assets = new Assets(d, path.join(dataDir, "assets"));
  d.bootstrap(adminUsername, adminPassword);
  const limits = new Map();
  const token = (req) =>
    /(?:^|;\s*)sm_session=([a-f0-9]{64})(?:;|$)/.exec(
      req.headers.cookie || "",
    )?.[1];
  const cookie = (t) =>
    `sm_session=${t}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${t ? 28800 : 0}${secureCookies ? "; Secure" : ""}`;
  async function body(req, max = 2 * 1024 * 1024) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > max) fail(413, "TOO_LARGE", "请求体过大");
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }
  const server = http.createServer(async (req, res) => {
    const requestId = uid();
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    const send = (value, status = 200) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify({ data: value, requestId }));
    };
    try {
      const url = new URL(req.url, "http://localhost"),
        p = url.pathname,
        m = req.method;
      const seg = p.split("/").filter(Boolean);
      if (m === "GET" && p === "/health")
        return send({
          service: "space-master",
          version: "0.1.0",
          environment,
          revision,
          sandboxPayments: !!sandboxSecret,
        });
      if (
        m === "GET" &&
        [
          "/",
          "/app.js",
          "/style.css",
          "/geometry.mjs",
          "/viewer.bundle.js",
        ].includes(p)
      ) {
        const name = p === "/" ? "index.html" : p.slice(1),
          file =
            p === "/geometry.mjs"
              ? path.join(base, "src", name)
              : path.join(base, "web", name);
        res.writeHead(200, {
          "Content-Type": name.endsWith(".html")
            ? "text/html; charset=utf-8"
            : name.endsWith(".css")
              ? "text/css"
              : "text/javascript",
        });
        let page = await fs.readFile(file);
        if (name === "index.html" && environment === "isolated-qa") {
          page = Buffer.from(
            page
              .toString()
              .replace(
                "<body>",
                '<body><div role="note" style="position:fixed;bottom:0;left:0;right:0;z-index:999;background:#664b12;color:#fff2c9;padding:8px 20px;text-align:center">隔离验收环境 · 全部为虚构样例 · 付款入口关闭 · 请勿录入真实客户资料</div>',
              ),
          );
        }
        return res.end(page);
      }
      if (!p.startsWith("/api/v1/")) fail(404, "NOT_FOUND", "接口不存在");
      if (!["GET", "HEAD"].includes(m)) {
        const origin = req.headers.origin;
        if (
          origin &&
          origin !== `${secureCookies ? "https" : "http"}://${req.headers.host}`
        )
          fail(403, "ORIGIN", "跨站请求被拒绝");
        if (req.headers["sec-fetch-site"] === "cross-site")
          fail(403, "ORIGIN", "跨站请求被拒绝");
      }
      if (m === "POST" && p === "/api/v1/payment-webhooks/sandbox") {
        if (!sandboxSecret) fail(503, "PAYMENT_DISABLED", "未开启沙箱付款");
        const raw = await body(req, 65536),
          expected = crypto
            .createHmac("sha256", sandboxSecret)
            .update(raw)
            .digest("hex"),
          sig = req.headers["x-signature"];
        if (
          typeof sig !== "string" ||
          !/^[a-f0-9]{64}$/.test(sig) ||
          !crypto.timingSafeEqual(
            Buffer.from(expected, "hex"),
            Buffer.from(sig, "hex"),
          )
        )
          fail(401, "SIGNATURE", "支付回调签名无效");
        let j;
        try {
          j = JSON.parse(raw);
        } catch {
          fail(422, "JSON", "JSON格式错误");
        }
        return send(store.tx(() => d.payment("sandbox", j, raw)));
      }
      const json = async () => {
        if (!req.headers["content-type"]?.startsWith("application/json"))
          fail(415, "CONTENT_TYPE", "请使用application/json");
        let j;
        try {
          j = JSON.parse((await body(req)).toString());
        } catch (e) {
          if (e instanceof Fault) throw e;
          fail(422, "JSON", "JSON格式错误");
        }
        if (!j || typeof j !== "object" || Array.isArray(j))
          fail(422, "JSON", "请求必须是JSON对象");
        return j;
      };
      if (m === "POST" && p === "/api/v1/auth/login") {
        const key = req.socket.remoteAddress;
        const now = Date.now(),
          limit = limits.get(key);
        if (limit && limit.until > now && limit.count >= 20)
          fail(429, "RATE_LIMIT", "登录尝试过多，请15分钟后重试");
        if (!limit || limit.until <= now)
          limits.set(key, { count: 0, until: now + 900000 });
        limits.get(key).count++;
        if (limits.size > 10000)
          for (const [k, v] of limits) if (v.until < now) limits.delete(k);
        const j = await json(),
          t = store.tx(() => d.login(j));
        res.setHeader("Set-Cookie", cookie(t));
        return send({ ok: true });
      }
      const u = d.auth(token(req));
      let j;
      if (!["GET", "HEAD", "DELETE"].includes(m) && !p.includes("/parts/"))
        j = await json();
      const mutate = (fn) => send(store.tx(fn));
      if (p === "/api/v1/me" && m === "GET") return send(d.me(u));
      if (p === "/api/v1/auth/logout" && m === "POST") {
        store.run("DELETE FROM sessions WHERE hash=?", hash(token(req)));
        res.setHeader("Set-Cookie", cookie(""));
        return send({ ok: true });
      }
      if (p === "/api/v1/users" && m === "POST")
        return mutate(() => d.user(u, j));
      if (p === "/api/v1/admin/users" && m === "GET") {
        d.platform(u);
        return send(store.all("SELECT id,username,disabled FROM users"));
      }
      if (p === "/api/v1/admin/audit" && m === "GET") {
        d.platform(u);
        return send(
          store.all("SELECT * FROM audit ORDER BY id DESC LIMIT 100"),
        );
      }
      if (p === "/api/v1/admin/suppliers" && m === "POST")
        return mutate(() => d.supplier(u, j));
      if (p === "/api/v1/admin/suppliers" && m === "GET") {
        d.platform(u);
        return send(store.all("SELECT id,name FROM suppliers"));
      }
      if (p === "/api/v1/enterprises" && m === "POST")
        return mutate(() => d.workspace(u, j.name));
      if (p === "/api/v1/invitations" && m === "GET")
        return send(
          store.all(
            "SELECT i.*,w.name workspace_name FROM invitations i JOIN workspaces w ON w.id=i.workspace_id WHERE i.user_id=? AND i.status='pending' AND i.expires>?",
            u.id,
            Date.now(),
          ),
        );
      if (seg[2] === "invitations" && seg[4] === "accept" && m === "POST")
        return mutate(() => d.accept(u, seg[3]));
      if (seg[2] === "workspaces") {
        const w = seg[3],
          kind = seg[4],
          id = seg[5];
        if (kind === "invitations" && m === "POST")
          return mutate(() => d.invite(u, w, j));
        if (kind === "members" && m === "GET") {
          d.access(u, w, ["owner", "admin"]);
          return send(
            store.all(
              "SELECT m.user_id,m.role,m.status,u.username FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=?",
              w,
            ),
          );
        }
        if (kind === "members" && id && m === "DELETE")
          return mutate(() => d.revoke(u, w, id));
        if (kind === "customers" && m === "POST")
          return mutate(() => d.customer(u, w, j));
        if (kind === "customers" && m === "GET") {
          d.access(u, w, ["owner", "admin"]);
          return send(
            store.all("SELECT * FROM customers WHERE workspace_id=?", w),
          );
        }
        if (kind === "projects" && m === "POST")
          return mutate(() => d.createProject(u, w, j));
        if (kind === "projects" && m === "GET") return send(d.projects(u, w));
        if (kind === "catalog" && m === "GET") return send(d.catalog(u, w));
        if (kind === "families" && m === "POST")
          return mutate(() => d.family(u, w, j));
        if (kind === "families" && m === "GET") {
          d.role(u, w);
          return send(
            store.all("SELECT * FROM families WHERE workspace_id=?", w),
          );
        }
        if (kind === "variants" && m === "POST")
          return mutate(() => d.variant(u, w, j));
        if (kind === "offers" && m === "POST")
          return mutate(() => d.offer(u, w, j));
        if (kind === "assets" && m === "GET") {
          d.role(u, w);
          return send(
            store.all(
              "SELECT id,name,size,sha256,state,format FROM assets WHERE workspace_id=?",
              w,
            ),
          );
        }
        if (kind === "uploads" && m === "POST")
          return send(await assets.init(u, w, j));
      }
      if (seg[2] === "uploads") {
        const id = seg[3];
        if (seg[4] === "parts" && m === "PUT")
          return send(
            await assets.part(
              u,
              id,
              Number(seg[5]),
              await body(req, 4 * 1024 * 1024),
            ),
          );
        if (seg[4] === "complete" && m === "POST")
          return send(await assets.complete(u, id));
        if (seg.length === 4 && m === "GET") return send(assets.status(u, id));
      }
      if (seg[2] === "assets" && seg[4] === "original" && m === "GET") {
        const file = assets.raw(u, seg[3]);
        res.writeHead(200, {
          "Content-Type": "model/gltf-binary",
          "Content-Disposition": "attachment",
        });
        return await pipeline(createReadStream(file), res);
      }
      if (seg[2] === "projects") {
        const id = seg[3],
          action = seg[4];
        if (m === "GET" && !action) return send(d.project(u, id));
        if (m === "PUT" && !action) return mutate(() => d.save(u, id, j));
        if (m === "POST" && action === "submit")
          return mutate(() => d.submit(u, id, j));
        if (m === "POST" && action === "fork")
          return mutate(() => d.fork(u, id, j));
        if (m === "POST" && action === "reassign")
          return mutate(() => d.reassign(u, id, j));
        if (m === "GET" && action === "bom") {
          const b = d.bom(d.project(u, id));
          return send({
            ...b,
            lines: b.lines.map(({ costFen, supplierId, ...x }) => x),
          });
        }
      }
      if (p === "/api/v1/submissions" && m === "GET")
        return send(
          store
            .all(
              "SELECT id,project_id,customer_user_id,state,hash,json_extract(payload, '$.projectName') AS projectName,json_extract(payload, '$.version') AS version FROM submissions",
            )
            .filter(
              (a) =>
                a.customer_user_id === u.id || d.canProject(u, a.project_id),
            ),
        );
      if (seg[2] === "submissions") {
        const id = seg[3],
          action = seg[4];
        if (m === "GET" && !action) return send(d.publicSubmission(u, id));
        if (m === "POST" && action === "review")
          return mutate(() => d.review(u, id, j));
        if (m === "POST" && action === "comments")
          return mutate(() => d.comment(u, id, j));
        if (m === "POST" && action === "finalize")
          return mutate(() => d.finalize(u, id));
        if (m === "POST" && action === "choice")
          return mutate(() => d.choose(u, id, j));
        if (m === "GET" && action === "export") {
          const a = d.submission(u, id),
            choice = store.get(
              "SELECT choice FROM choices WHERE submission_id=?",
              id,
            );
          if (!choice) fail(409, "CHOICE", "请先完成采购选择");
          const b = d.publicSubmission(u, id).bom;
          const cell = (x) =>
            '"' +
            String(x)
              .replace(/^[=+@\-\t\r]/, "'$&")
              .replaceAll('"', '""') +
            '"';
          const rows = [
            [
              "SKU",
              "名称",
              "宽mm",
              "深mm",
              "高mm",
              "数量",
              "销售单价分",
              "小计分",
            ],
            ...b.lines.map((x) => [
              x.sku,
              x.name,
              x.width,
              x.depth,
              x.height,
              x.quantity,
              x.unitPriceFen,
              x.subtotalFen,
            ]),
          ];
          res.writeHead(200, {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="bom.csv"',
          });
          return res.end(
            "\uFEFF" + rows.map((r) => r.map(cell).join(",")).join("\r\n"),
          );
        }
      }
      if (p === "/api/v1/orders" && m === "GET") return send(d.orders(u));
      if (p === "/api/v1/purchases" && m === "GET") return send(d.purchases(u));
      if (seg[2] === "purchases" && seg[4] === "status" && m === "POST")
        return mutate(() => d.purchaseStep(u, seg[3], j));
      fail(404, "NOT_FOUND", "接口不存在");
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const known = e instanceof Fault;
      res.writeHead(known ? e.status : 500, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(
        JSON.stringify({
          error: {
            code: known ? e.code : "INTERNAL",
            message: known ? e.message : "服务器内部错误",
          },
          requestId,
        }),
      );
      if (!known) console.error({ requestId, error: e.message });
    }
  });
  return { server, store, domain: d, assets };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const secure = process.env.SECURE_COOKIES === "true";
  if (process.env.NODE_ENV === "production" && !secure)
    throw Error("生产环境必须配置HTTPS及SECURE_COOKIES=true");
  const app = createApp({
    dataDir: process.env.DATA_DIR,
    adminUsername: process.env.SEED_ADMIN_USERNAME,
    adminPassword: process.env.SEED_ADMIN_PASSWORD,
    sandboxSecret: process.env.SANDBOX_PAYMENT_SECRET,
    secureCookies: secure,
    revision: process.env.APP_REVISION || "workspace",
  });
  app.server.listen(
    Number(process.env.PORT || 3000),
    process.env.HOST || "127.0.0.1",
    () =>
      console.log(
        "Space Master listening; sandbox=" +
          !!process.env.SANDBOX_PAYMENT_SECRET,
      ),
  );
}
