import crypto from "node:crypto";
import { defaultScene, validateScene } from "./geometry.mjs";
export class Fault extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const fail = (s, c, m) => {
  throw new Fault(s, c, m);
};
export const uid = () => crypto.randomUUID(),
  now = () => new Date().toISOString(),
  hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
const text = (s, max = 120) => {
  if (typeof s !== "string" || !s.trim() || s.length > max)
    fail(422, "INVALID_TEXT", "请输入有效文本");
  return s.trim();
};
const integer = (n, min = 0, max = 1e9) => {
  if (!Number.isSafeInteger(n) || n < min || n > max)
    fail(422, "INVALID_NUMBER", "整数或金额超出范围");
  return n;
};
const password = (p) => {
  if (typeof p !== "string" || p.length < 12 || p.length > 256)
    fail(422, "PASSWORD", "密码长度需12–256位");
  return p;
};
const passHash = (p) => {
  const salt = crypto.randomBytes(16).toString("hex");
  return salt + ":" + crypto.scryptSync(password(p), salt, 64).toString("hex");
};
const verify = (p, stored) => {
  if (typeof p !== "string" || p.length > 256) return false;
  const [s, h] = stored.split(":");
  return crypto.timingSafeEqual(
    crypto.scryptSync(p, s, 64),
    Buffer.from(h, "hex"),
  );
};
const roles = ["admin", "designer", "viewer", "product_manager", "finance"];
export class Domain {
  constructor(store) {
    this.s = store;
  }
  audit(u, action, target) {
    this.s.run(
      "INSERT INTO audit(actor_id,action,target,created_at) VALUES(?,?,?,?)",
      u?.id ?? null,
      action,
      target,
      now(),
    );
  }
  active(u) {
    const a = this.s.get(
      "SELECT * FROM users WHERE id=? AND disabled=0",
      u?.id ?? "",
    );
    if (!a) fail(401, "SESSION", "账号已失效");
    return a;
  }
  platform(u) {
    if (!this.active(u).platform_admin)
      fail(403, "FORBIDDEN", "需要平台管理权限");
  }
  role(u, w) {
    this.active(u);
    const a = this.s.get("SELECT * FROM workspaces WHERE id=?", w);
    if (!a) fail(404, "NOT_FOUND", "工作空间不存在");
    const m = this.s.get(
      "SELECT role FROM memberships WHERE workspace_id=? AND user_id=? AND status='active'",
      w,
      u.id,
    );
    if (!m) fail(403, "WORKSPACE_FORBIDDEN", "无工作空间权限或成员已离职");
    return m.role;
  }
  access(u, w, allowed) {
    const r = this.role(u, w);
    if (allowed && !allowed.includes(r))
      fail(403, "FORBIDDEN", "当前岗位无此权限");
    return r;
  }
  workspace(u, name, type = "enterprise") {
    this.active(u);
    const id = uid();
    this.s.run(
      "INSERT INTO workspaces VALUES(?,?,?,?)",
      id,
      text(name),
      type,
      u.id,
    );
    this.s.run(
      "INSERT INTO memberships VALUES(?,?,?,'active')",
      id,
      u.id,
      "owner",
    );
    this.audit(u, "workspace.create", id);
    return this.s.get("SELECT * FROM workspaces WHERE id=?", id);
  }
  user(actor, j, bootstrap = false) {
    if (!bootstrap) this.platform(actor);
    const username = text(j.username, 40);
    if (!/^[\w.-]{3,40}$/.test(username))
      fail(422, "USERNAME", "账号须为3–40位字母数字或_.-");
    if (this.s.get("SELECT id FROM users WHERE username=?", username))
      fail(409, "EXISTS", "账号已存在");
    const id = uid();
    this.s.run(
      "INSERT INTO users(id,username,password,platform_admin) VALUES(?,?,?,?)",
      id,
      username,
      passHash(j.password),
      bootstrap ? 1 : 0,
    );
    const u = { id, username };
    this.workspace(u, username + "的个人空间", "personal");
    this.audit(actor, "user.create", id);
    return u;
  }
  bootstrap(username, p) {
    if (!username && !p) return;
    if (!username || !p) throw Error("初始化账号配置不完整");
    if (!this.s.get("SELECT id FROM users LIMIT 1"))
      this.s.tx(() => this.user(null, { username, password: p }, true));
  }
  login(j) {
    const u = this.s.get(
      "SELECT * FROM users WHERE username=?",
      typeof j.username === "string" ? j.username : "",
    );
    if (!u || u.disabled || !verify(j.password, u.password))
      fail(401, "LOGIN", "账号或密码错误");
    const token = crypto.randomBytes(32).toString("hex");
    this.s.run("DELETE FROM sessions WHERE expires<?", Date.now());
    this.s.run(
      "INSERT INTO sessions VALUES(?,?,?)",
      hash(token),
      u.id,
      Date.now() + 8 * 3600e3,
    );
    this.audit(u, "login", u.id);
    return token;
  }
  auth(token) {
    const u = this.s.get(
      "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires>? AND u.disabled=0",
      hash(token || ""),
      Date.now(),
    );
    if (!u) fail(401, "SESSION", "请重新登录");
    return u;
  }
  me(u) {
    return {
      user: {
        id: u.id,
        username: u.username,
        platformAdmin: !!u.platform_admin,
      },
      workspaces: this.s.all(
        "SELECT w.*,m.role FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=? AND m.status='active'",
        u.id,
      ),
    };
  }
  invite(u, w, j) {
    this.access(u, w, ["owner", "admin"]);
    if (
      this.s.get("SELECT type FROM workspaces WHERE id=?", w).type !==
      "enterprise"
    )
      fail(422, "PERSONAL", "个人空间不可邀请成员");
    if (!roles.includes(j.role)) fail(422, "ROLE", "岗位无效");
    const target = this.s.get(
      "SELECT id FROM users WHERE username=? AND disabled=0",
      text(j.username),
    );
    if (!target) fail(404, "USER", "账号不存在");
    const id = uid();
    this.s.run(
      "INSERT INTO invitations VALUES(?,?,?,?,?,'pending')",
      id,
      w,
      target.id,
      j.role,
      Date.now() + 7 * 86400e3,
    );
    this.audit(u, "invitation.create", id);
    return { id };
  }
  accept(u, id) {
    const i = this.s.get(
      "SELECT * FROM invitations WHERE id=? AND user_id=? AND status='pending' AND expires>?",
      id,
      u.id,
      Date.now(),
    );
    if (!i) fail(403, "INVITE", "邀请不存在或已失效");
    const m = this.s.get(
      "SELECT * FROM memberships WHERE workspace_id=? AND user_id=?",
      i.workspace_id,
      u.id,
    );
    if (m?.status === "active")
      fail(409, "MEMBER", "已经是成员，请由管理员处理角色");
    this.s.run(
      "INSERT INTO memberships VALUES(?,?,?,'active') ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role,status='active'",
      i.workspace_id,
      u.id,
      i.role,
    );
    this.s.run("UPDATE invitations SET status='accepted' WHERE id=?", id);
    this.audit(u, "invitation.accept", id);
    return { workspaceId: i.workspace_id };
  }
  revoke(u, w, id) {
    this.access(u, w, ["owner", "admin"]);
    const m = this.s.get(
      "SELECT * FROM memberships WHERE workspace_id=? AND user_id=?",
      w,
      id,
    );
    if (!m) fail(404, "MEMBER", "成员不存在");
    if (
      m.role === "owner" ||
      (m.role === "admin" && this.role(u, w) !== "owner")
    )
      fail(403, "OWNER", "无权移除此管理成员");
    this.s.run(
      "UPDATE memberships SET status='revoked' WHERE workspace_id=? AND user_id=?",
      w,
      id,
    );
    this.s.run(
      "UPDATE invitations SET status='revoked' WHERE workspace_id=? AND user_id=? AND status='pending'",
      w,
      id,
    );
    this.audit(u, "membership.revoke", id);
    return { revoked: true };
  }
  customer(u, w, j) {
    this.access(u, w, ["owner", "admin"]);
    const user = this.s.get(
      "SELECT id FROM users WHERE username=? AND disabled=0",
      text(j.username),
    );
    if (!user) fail(404, "CUSTOMER", "客户需先注册账号");
    const id = uid();
    if (
      this.s.get(
        "SELECT id FROM customers WHERE workspace_id=? AND user_id=?",
        w,
        user.id,
      )
    )
      fail(409, "EXISTS", "客户已存在");
    this.s.run(
      "INSERT INTO customers VALUES(?,?,?,?)",
      id,
      w,
      user.id,
      text(j.name),
    );
    this.audit(u, "customer.create", id);
    return { id };
  }
  project(u, id, edit = false) {
    const p = this.s.get("SELECT * FROM projects WHERE id=?", id);
    if (!p) fail(404, "PROJECT", "项目不存在");
    const r = this.role(u, p.workspace_id);
    if (
      !["owner", "admin"].includes(r) &&
      !(r === "designer" && p.designer_id === u.id)
    )
      fail(403, "PROJECT_FORBIDDEN", "未分配本项目");
    return { ...p, scene: JSON.parse(p.scene) };
  }
  projects(u, w) {
    const r = this.role(u, w);
    return this.s
      .all(
        "SELECT id,name,version,status,designer_id,customer_id FROM projects WHERE workspace_id=?" +
          (["owner", "admin"].includes(r) ? "" : " AND designer_id=?"),
        ...(["owner", "admin"].includes(r) ? [w] : [w, u.id]),
      )
      .filter((p) => ["owner", "admin", "designer"].includes(r));
  }
  createProject(u, w, j) {
    this.access(u, w, ["owner", "admin", "designer"]);
    if (
      j.customerId &&
      !this.s.get(
        "SELECT id FROM customers WHERE id=? AND workspace_id=?",
        j.customerId,
        w,
      )
    )
      fail(422, "CUSTOMER", "客户归属不匹配");
    const id = uid(),
      scene = defaultScene();
    this.s.run(
      "INSERT INTO projects VALUES(?,?,?,?,?,1,'draft',?)",
      id,
      w,
      j.customerId || null,
      u.id,
      text(j.name),
      JSON.stringify(scene),
    );
    this.revision(u, id, 1, scene);
    this.audit(u, "project.create", id);
    return this.project(u, id);
  }
  revision(u, id, v, scene) {
    const raw = JSON.stringify(scene);
    this.s.run(
      "INSERT INTO revisions VALUES(?,?,?,?,?,?)",
      uid(),
      id,
      v,
      raw,
      hash(raw),
      u.id,
    );
  }
  save(u, id, j) {
    const p = this.project(u, id, true);
    if (p.version !== j.expectedVersion)
      fail(409, "VERSION", "版本冲突，请重新读取后合并");
    if (!["draft", "changes_requested"].includes(p.status))
      fail(409, "LOCKED", "已提交方案不可覆盖，请新建修订");
    const e = validateScene(j.scene);
    if (e.length) fail(422, "GEOMETRY", JSON.stringify(e));
    this.checkReferences(p.workspace_id, j.scene);
    const v = p.version + 1;
    this.s.run(
      "UPDATE projects SET scene=?,version=?,status='draft' WHERE id=?",
      JSON.stringify(j.scene),
      v,
      id,
    );
    this.revision(u, id, v, j.scene);
    this.audit(u, "scene.save", id);
    return this.project(u, id);
  }
  checkReferences(w, scene) {
    for (const o of scene.objects.filter((o) => o.source === "new")) {
      const v = this.s.get(
        "SELECT * FROM variants WHERE id=? AND workspace_id=?",
        o.variantId,
        w,
      );
      const f = this.s.get(
        "SELECT * FROM offers WHERE id=? AND workspace_id=? AND variant_id=?",
        o.offerId,
        w,
        o.variantId,
      );
      if (!v || !f) fail(422, "SKU", "SKU或供给不存在于此工作空间");
      if (
        v.width_mm !== o.width ||
        v.depth_mm !== o.depth ||
        v.height_mm !== o.height
      )
        fail(
          422,
          "SKU_DIMENSIONS",
          "商品尺寸应等于真实SKU尺寸，定制请新建变体",
        );
    }
  }
  reassign(u, id, j) {
    const p = this.project(u, id);
    this.access(u, p.workspace_id, ["owner", "admin"]);
    this.access({ id: j.designerId }, p.workspace_id, [
      "owner",
      "admin",
      "designer",
    ]);
    this.s.run(
      "UPDATE projects SET designer_id=? WHERE id=?",
      j.designerId,
      id,
    );
    this.audit(u, "project.reassign", id);
    return { ok: true };
  }
  family(u, w, j) {
    this.access(u, w, ["owner", "admin", "product_manager"]);
    const id = uid();
    this.s.run("INSERT INTO families VALUES(?,?,?)", id, w, text(j.name));
    this.audit(u, "family.create", id);
    return { id };
  }
  variant(u, w, j) {
    this.access(u, w, ["owner", "admin", "product_manager"]);
    if (
      !this.s.get(
        "SELECT id FROM families WHERE id=? AND workspace_id=?",
        j.familyId,
        w,
      )
    )
      fail(422, "FAMILY", "产品系列不存在");
    if (
      j.assetId &&
      !this.s.get(
        "SELECT id FROM assets WHERE id=? AND workspace_id=? AND state='stored_unverified'",
        j.assetId,
        w,
      )
    )
      fail(422, "ASSET", "模型资产归属不匹配");
    const id = uid();
    this.s.run(
      "INSERT INTO variants VALUES(?,?,?,?,?,?,?,?,?)",
      id,
      w,
      j.familyId,
      text(j.sku, 80),
      text(j.name),
      integer(j.width, 1, 100000),
      integer(j.depth, 1, 100000),
      integer(j.height, 1, 100000),
      j.assetId || null,
    );
    this.audit(u, "variant.create", id);
    return { id };
  }
  supplier(u, j) {
    this.platform(u);
    const a = this.s.get(
      "SELECT id FROM users WHERE username=?",
      text(j.username),
    );
    if (!a) fail(422, "SUPPLIER", "供应商账号不存在");
    const id = uid();
    this.s.run("INSERT INTO suppliers VALUES(?,?,?)", id, text(j.name), a.id);
    this.audit(u, "supplier.create", id);
    return { id };
  }
  offer(u, w, j) {
    this.access(u, w, ["owner", "admin", "product_manager"]);
    if (
      !this.s.get(
        "SELECT id FROM variants WHERE id=? AND workspace_id=?",
        j.variantId,
        w,
      ) ||
      !this.s.get("SELECT id FROM suppliers WHERE id=?", j.supplierId)
    )
      fail(422, "OFFER", "SKU或供应商不存在");
    const id = uid();
    this.s.run(
      "INSERT INTO offers VALUES(?,?,?,?,?,?,?,?,1)",
      id,
      w,
      j.variantId,
      j.supplierId,
      integer(j.saleFen),
      integer(j.costFen),
      integer(j.stock),
      integer(j.validUntil, Date.now(), Date.now() + 366 * 86400e3),
    );
    this.audit(u, "offer.create", id);
    return { id };
  }
  catalog(u, w) {
    const r = this.role(u, w);
    return this.s
      .all(
        "SELECT v.*,o.id offer_id,o.sale_fen,o.cost_fen,o.stock,o.valid_until,o.version price_version,o.supplier_id FROM variants v LEFT JOIN offers o ON o.variant_id=v.id AND o.workspace_id=v.workspace_id WHERE v.workspace_id=?",
        w,
      )
      .map((x) => {
        if (!["owner", "admin", "finance", "product_manager"].includes(r)) {
          delete x.cost_fen;
          delete x.supplier_id;
        }
        return x;
      });
  }
  bom(p) {
    this.checkReferences(p.workspace_id, p.scene);
    const grouped = new Map();
    for (const o of p.scene.objects) {
      if (o.source === "existing") continue;
      const k = o.variantId + "|" + o.offerId;
      if (!grouped.has(k)) {
        const v = this.s.get(
            "SELECT * FROM variants WHERE id=? AND workspace_id=?",
            o.variantId,
            p.workspace_id,
          ),
          f = this.s.get(
            "SELECT * FROM offers WHERE id=? AND workspace_id=?",
            o.offerId,
            p.workspace_id,
          );
        if (f.valid_until < Date.now()) fail(409, "EXPIRED", "供给报价已过期");
        grouped.set(k, {
          variantId: v.id,
          offerId: f.id,
          name: v.name,
          sku: v.sku,
          width: v.width_mm,
          depth: v.depth_mm,
          height: v.height_mm,
          quantity: 0,
          unitPriceFen: f.sale_fen,
          costFen: f.cost_fen,
          supplierId: f.supplier_id,
          priceVersion: f.version,
        });
      }
      grouped.get(k).quantity++;
    }
    const lines = [...grouped.values()];
    for (const l of lines) {
      const f = this.s.get("SELECT stock FROM offers WHERE id=?", l.offerId);
      if (f.stock < l.quantity) fail(409, "STOCK", "库存不足");
      l.subtotalFen = l.quantity * l.unitPriceFen;
    }
    const totalFen = lines.reduce((s, l) => s + l.subtotalFen, 0);
    integer(totalFen, 0, Number.MAX_SAFE_INTEGER);
    return { lines, totalFen, currency: "CNY" };
  }
  submit(u, id, j) {
    const p = this.project(u, id, true);
    if (p.version !== j.expectedVersion) fail(409, "VERSION", "提交版本冲突");
    if (p.status !== "draft") fail(409, "STATE", "只能提交草稿");
    const c = this.s.get(
      "SELECT * FROM customers WHERE id=? AND workspace_id=?",
      p.customer_id,
      p.workspace_id,
    );
    if (!c || c.user_id === u.id) fail(422, "CUSTOMER", "请指定其他客户账号");
    const e = validateScene(p.scene);
    if (e.length) fail(422, "GEOMETRY", "场景存在错误");
    const b = this.bom(p),
      r = this.s.get(
        "SELECT id FROM revisions WHERE project_id=? AND version=?",
        id,
        p.version,
      );
    const sid = uid(),
      payload = JSON.stringify({
        projectName: p.name,
        version: p.version,
        scene: p.scene,
        bom: b,
      });
    const exp = Math.min(
      Date.now() + 7 * 86400e3,
      ...b.lines.map(
        (l) =>
          this.s.get("SELECT valid_until FROM offers WHERE id=?", l.offerId)
            .valid_until,
      ),
    );
    this.s.run(
      "INSERT INTO submissions VALUES(?,?,?,?,?,?,'client_review',?,?)",
      sid,
      id,
      r.id,
      c.user_id,
      payload,
      hash(payload),
      exp,
      now(),
    );
    this.s.run("UPDATE projects SET status='under_review' WHERE id=?", id);
    this.audit(u, "submission.create", sid);
    return { id: sid, hash: hash(payload) };
  }
  submission(u, id) {
    const a = this.s.get("SELECT * FROM submissions WHERE id=?", id);
    if (!a) fail(404, "SUBMISSION", "提交不存在");
    if (a.customer_user_id !== u.id) this.project(u, a.project_id);
    return a;
  }
  publicSubmission(u, id) {
    const a = this.submission(u, id),
      p = JSON.parse(a.payload);
    p.bom.lines = p.bom.lines.map(({ costFen, supplierId, ...x }) => x);
    return {
      id: a.id,
      projectId: a.project_id,
      state: a.state,
      hash: a.hash,
      expires: a.expires,
      ...p,
      approvals: this.s.all(
        "SELECT kind,actor_id,hash,created_at FROM approvals WHERE submission_id=?",
        id,
      ),
      comments: this.s.all("SELECT * FROM comments WHERE submission_id=?", id),
    };
  }
  review(u, id, j) {
    const a = this.submission(u, id);
    if (u.id !== a.customer_user_id)
      fail(403, "CUSTOMER_ONLY", "仅指定客户可确认");
    if (a.hash !== j.hash) fail(409, "HASH", "确认版本哈希不一致");
    if (a.state !== "client_review" || a.expires < Date.now())
      fail(409, "STATE", "此提交已处理或过期");
    if (j.action === "changes") {
      this.s.run(
        "UPDATE submissions SET state='changes_requested' WHERE id=?",
        id,
      );
      this.s.run(
        "UPDATE projects SET status='changes_requested' WHERE id=?",
        a.project_id,
      );
    } else {
      if (!["design", "bom"].includes(j.action))
        fail(422, "ACTION", "确认范围无效");
      this.s.run(
        "INSERT OR IGNORE INTO approvals VALUES(?,?,?,?,?)",
        id,
        j.action,
        u.id,
        a.hash,
        now(),
      );
      if (
        this.s.get("SELECT count(*) n FROM approvals WHERE submission_id=?", id)
          .n === 2
      )
        this.s.run(
          "UPDATE submissions SET state='client_approved' WHERE id=?",
          id,
        );
    }
    this.audit(u, "review." + j.action, id);
    return this.publicSubmission(u, id);
  }
  comment(u, id, j) {
    this.submission(u, id);
    this.s.run(
      "INSERT INTO comments VALUES(?,?,?,?,?)",
      uid(),
      id,
      u.id,
      text(j.body, 2000),
      now(),
    );
    this.audit(u, "comment.create", id);
    return { ok: true };
  }
  finalize(u, id) {
    const a = this.submission(u, id);
    this.project(u, a.project_id, true);
    if (a.state !== "client_approved" || a.expires < Date.now())
      fail(409, "STATE", "客户双确认未完成或报价过期");
    this.validateFrozen(a);
    this.s.run("UPDATE submissions SET state='finalized' WHERE id=?", id);
    this.s.run(
      "UPDATE projects SET status='finalized' WHERE id=?",
      a.project_id,
    );
    this.audit(u, "submission.finalize", id);
    return { state: "finalized" };
  }
  validateFrozen(a) {
    const b = JSON.parse(a.payload).bom;
    for (const l of b.lines) {
      const f = this.s.get("SELECT * FROM offers WHERE id=?", l.offerId);
      if (
        !f ||
        f.valid_until < Date.now() ||
        f.version !== l.priceVersion ||
        f.sale_fen !== l.unitPriceFen ||
        f.cost_fen !== l.costFen ||
        f.supplier_id !== l.supplierId ||
        f.stock < l.quantity
      )
        fail(409, "REQUOTE", "供给变更，需新报价并重新确认");
    }
    return b;
  }
  fork(u, id, j) {
    const p = this.project(u, id, true);
    if (j.expectedVersion !== p.version) fail(409, "VERSION", "版本冲突");
    if (!["finalized", "self_completed", "ordered"].includes(p.status))
      fail(409, "STATE", "仅锁版或交付后可新建修订");
    const v = p.version + 1;
    this.s.run(
      "UPDATE projects SET version=?,status='draft' WHERE id=?",
      v,
      id,
    );
    this.revision(u, id, v, p.scene);
    this.audit(u, "project.fork", id);
    return this.project(u, id);
  }
  choose(u, id, j) {
    const a = this.submission(u, id);
    if (a.customer_user_id !== u.id)
      fail(403, "CUSTOMER_ONLY", "仅客户可选择采购");
    if (!["self", "platform"].includes(j.choice))
      fail(422, "CHOICE", "请选择采购方式");
    const existing = this.s.get(
      "SELECT * FROM choices WHERE submission_id=?",
      id,
    );
    if (existing) {
      if (existing.choice !== j.choice)
        fail(409, "CHOICE_LOCKED", "采购选择已记录，变更需重新报价");
      return {
        choice: existing.choice,
        order:
          this.s.get(
            "SELECT id,status FROM sales_orders WHERE submission_id=?",
            id,
          ) || null,
      };
    }
    if (a.state !== "finalized") fail(409, "STATE", "设计师尚未终审");
    let order = null;
    if (j.choice === "platform") {
      if (a.expires < Date.now()) fail(409, "EXPIRED", "报价已过期");
      const b = this.validateFrozen(a);
      if (!b.lines.length || b.totalFen <= 0)
        fail(422, "EMPTY_ORDER", "空清单或零金额不生成商品销售订单");
      order = { id: uid(), status: "awaiting_payment" };
      this.s.run(
        "INSERT INTO sales_orders VALUES(?,?,?,?,?,?,?)",
        order.id,
        id,
        u.id,
        b.totalFen,
        b.currency,
        order.status,
        JSON.stringify(b.lines),
      );
    }
    this.s.run(
      "INSERT INTO choices VALUES(?,?,?,?)",
      id,
      j.choice,
      u.id,
      now(),
    );
    this.s.run(
      "UPDATE submissions SET state=? WHERE id=?",
      j.choice === "self" ? "self_completed" : "ordered",
      id,
    );
    this.s.run(
      "UPDATE projects SET status=? WHERE id=?",
      j.choice === "self" ? "self_completed" : "ordered",
      a.project_id,
    );
    this.audit(u, "procurement." + j.choice, id);
    return { choice: j.choice, order };
  }
  orders(u) {
    this.active(u);
    return this.s
      .all("SELECT * FROM sales_orders")
      .filter(
        (o) =>
          o.customer_user_id === u.id ||
          this.canProject(
            u,
            this.s.get(
              "SELECT project_id FROM submissions WHERE id=?",
              o.submission_id,
            ).project_id,
          ),
      )
      .map((o) => ({
        ...o,
        lines: JSON.parse(o.lines).map(({ costFen, supplierId, ...x }) => x),
      }));
  }
  canProject(u, id) {
    try {
      this.project(u, id);
      return true;
    } catch {
      return false;
    }
  }
  payment(provider, event, raw) {
    if (provider !== "sandbox")
      fail(503, "PAYMENT_PROVIDER", "尚未配置正式支付适配器");
    const { eventId, orderId, amountFen, currency } = event;
    text(eventId, 100);
    const prior = this.s.get(
      "SELECT * FROM payment_events WHERE provider=? AND event_id=?",
      provider,
      eventId,
    );
    if (prior) {
      if (prior.digest !== hash(raw))
        fail(409, "PAYMENT_EVENT", "同一事件内容冲突");
      return { duplicate: true };
    }
    const o = this.s.get("SELECT * FROM sales_orders WHERE id=?", orderId);
    if (!o) fail(404, "ORDER", "订单不存在");
    if (o.amount_fen !== amountFen || o.currency !== currency)
      fail(422, "PAYMENT_AMOUNT", "付款金额或币种不匹配");
    if (o.status === "paid_sandbox") {
      this.s.run(
        "INSERT INTO payment_events VALUES(?,?,?,?)",
        provider,
        eventId,
        o.id,
        hash(raw),
      );
      return { duplicate: true };
    }
    if (o.status !== "awaiting_payment") fail(409, "STATE", "订单不能收款");
    const a = this.s.get(
      "SELECT * FROM submissions WHERE id=?",
      o.submission_id,
    );
    if (a.expires < Date.now())
      fail(409, "EXPIRED", "订单已过期，需要人工核对退款");
    this.validateFrozen(a);
    const groups = new Map();
    for (const l of JSON.parse(o.lines)) {
      const changed = this.s.run(
        "UPDATE offers SET stock=stock-? WHERE id=? AND stock>=?",
        l.quantity,
        l.offerId,
        l.quantity,
      );
      if (changed.changes !== 1)
        fail(409, "STOCK", "库存不足，付款需人工异常处理");
      if (!groups.has(l.supplierId)) groups.set(l.supplierId, []);
      groups.get(l.supplierId).push({
        variantId: l.variantId,
        name: l.name,
        sku: l.sku,
        quantity: l.quantity,
        unitCostFen: l.costFen,
      });
    }
    for (const [supplier, lines] of groups)
      this.s.run(
        "INSERT INTO purchase_orders VALUES(?,?,?,'pending',?)",
        uid(),
        o.id,
        supplier,
        JSON.stringify(lines),
      );
    this.s.run(
      "INSERT INTO payment_events VALUES(?,?,?,?)",
      provider,
      eventId,
      o.id,
      hash(raw),
    );
    this.s.run(
      "UPDATE sales_orders SET status='paid_sandbox' WHERE id=?",
      o.id,
    );
    this.audit(null, "sandbox.payment", o.id);
    return { paid: true, sandbox: true, purchases: groups.size };
  }
  purchases(u) {
    return this.s
      .all(
        "SELECT p.* FROM purchase_orders p JOIN suppliers s ON s.id=p.supplier_id WHERE s.user_id=?",
        u.id,
      )
      .map((p) => ({ ...p, lines: JSON.parse(p.lines) }));
  }
  purchaseStep(u, id, j) {
    const p = this.s.get(
      "SELECT p.*,s.user_id FROM purchase_orders p JOIN suppliers s ON s.id=p.supplier_id WHERE p.id=?",
      id,
    );
    if (!p || p.user_id !== u.id) fail(403, "SUPPLIER", "仅本供应商可处理");
    const next = { pending: "accepted", accepted: "shipped" };
    if (next[p.status] !== j.status)
      fail(409, "STATE", "请按接单、发货顺序处理");
    this.s.run("UPDATE purchase_orders SET status=? WHERE id=?", j.status, id);
    this.audit(u, "purchase." + j.status, id);
    return { status: j.status };
  }
}
