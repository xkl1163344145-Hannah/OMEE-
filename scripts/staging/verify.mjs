import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
const [directory, url] = process.argv.slice(2);
if (!directory || !url)
  throw Error("用法 node scripts/staging/verify.mjs <QA_DATA_DIR> <测试URL>");
const base = new URL(url);
if (
  !["http:", "https:"].includes(base.protocol) ||
  base.username ||
  base.password
)
  throw Error("测试URL无效");
if (
  base.protocol === "http:" &&
  !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)
)
  throw Error("远程账号验证只允许HTTPS");
const root = path.resolve(directory),
  { accounts } = JSON.parse(
    fs.readFileSync(path.join(root, "accounts.private.json")),
  ),
  fixtures = JSON.parse(fs.readFileSync(path.join(root, "fixtures.json")));
const result = [];
const request = async (p, { method = "GET", cookie = "", body } = {}) => {
  const response = await fetch(new URL(p, base), {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
  });
  let json;
  try {
    json = await response.json();
  } catch {
    throw Error("测试实例返回非JSON，检查URL/代理/访问控制");
  }
  return { response, json };
};
const health = await request("/health");
assert.equal(health.json.data.environment, "isolated-qa");
assert.equal(health.json.data.sandboxPayments, false);
assert.equal(
  (
    await request("/api/v1/payment-webhooks/sandbox", {
      method: "POST",
      body: {},
    })
  ).response.status,
  503,
);
for (const a of accounts) {
  const login = await request("/api/v1/auth/login", {
    method: "POST",
    body: { username: a.username, password: a.password },
  });
  assert.equal(login.response.status, 200, "登录失败：" + a.username);
  const cookie = login.response.headers.get("set-cookie").split(";")[0];
  try {
    const me = (await request("/api/v1/me", { cookie })).json.data;
    assert.equal(me.user.username, a.username);
    if (a.username === "qa_designer") assert.equal(me.workspaces.length, 3);
    if (a.username === "qa_departed") {
      assert.equal(me.workspaces.length, 2);
      assert.equal(
        (
          await request("/api/v1/projects/" + fixtures.projects.departed, {
            cookie,
          })
        ).response.status,
        403,
      );
    }
    if (["qa_yadmin", "qa_outside"].includes(a.username))
      assert.equal(
        (
          await request("/api/v1/projects/" + fixtures.projects.edit, {
            cookie,
          })
        ).response.status,
        403,
      );
    if (a.username === "qa_client") {
      const submissions = await request("/api/v1/submissions", { cookie });
      assert.ok(
        submissions.json.data.some((a) => a.projectName?.includes("验收02")),
      );
      assert.ok(!JSON.stringify(submissions.json).includes("costFen"));
      const self = await request(
        "/api/v1/submissions/" + fixtures.submissions.self.id,
        { cookie },
      );
      assert.equal(self.json.data.bom.totalFen, 235000);
      assert.ok(!JSON.stringify(self.json).includes("costFen"));
    }
    if (a.username.startsWith("qa_supplier_")) {
      const purchases = (await request("/api/v1/purchases", { cookie })).json
        .data;
      assert.equal(purchases.length, 1);
      assert.equal(
        purchases[0].lines.length,
        a.username.endsWith("_a") ? 2 : 1,
      );
      assert.ok(!JSON.stringify(purchases).includes("unitPriceFen"));
    }
    result.push({
      account: a.username,
      result: "passed",
      workspaces: me.workspaces.length,
    });
  } finally {
    await request("/api/v1/auth/logout", { method: "POST", cookie, body: {} });
  }
}
console.log(
  JSON.stringify(
    {
      environment: "isolated-qa",
      checkedAt: new Date().toISOString(),
      paymentDisabled: true,
      passwordsPrinted: false,
      accounts: result,
    },
    null,
    2,
  ),
);
