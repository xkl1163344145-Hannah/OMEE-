import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.mjs";
import crypto from "node:crypto";
test("真实HTTP登录、工作空间、保存重开、401/403/409/422、CSRF与付款验签", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omee-http-"));
  const app = createApp({
    dataDir: dir,
    adminUsername: "testadmin",
    adminPassword: "test-password-123",
    sandboxSecret: "isolated-test-only-secret",
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await new Promise((r) => app.server.close(r));
    app.store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + app.server.address().port;
  let cookie = "";
  const call = async (p, m = "GET", j, headers = {}) => {
    const r = await fetch(base + p, {
      method: m,
      headers: {
        cookie,
        ...(j ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: j ? JSON.stringify(j) : undefined,
    });
    return { r, j: await r.json() };
  };
  assert.equal((await call("/api/v1/me")).r.status, 401);
  let login = await call("/api/v1/auth/login", "POST", {
    username: "testadmin",
    password: "test-password-123",
  });
  assert.equal(login.r.status, 200);
  cookie = login.r.headers.get("set-cookie").split(";")[0];
  assert.ok(login.r.headers.get("set-cookie").includes("HttpOnly"));
  assert.ok(!JSON.stringify(login.j).includes("token"));
  const me = (await call("/api/v1/me")).j.data,
    w = me.workspaces[0].id;
  const p = (
    await call("/api/v1/workspaces/" + w + "/projects", "POST", {
      name: "持久化房间",
    })
  ).j.data;
  assert.equal(p.version, 1);
  let saved = await call("/api/v1/projects/" + p.id, "PUT", {
    expectedVersion: 1,
    scene: p.scene,
  });
  assert.equal(saved.r.status, 200);
  assert.equal(saved.j.data.version, 2);
  assert.equal(
    (
      await call("/api/v1/projects/" + p.id, "PUT", {
        expectedVersion: 1,
        scene: p.scene,
      })
    ).r.status,
    409,
  );
  assert.equal((await call("/api/v1/projects/" + p.id)).j.data.version, 2);
  assert.equal(
    (await call("/api/v1/workspaces/foreign/projects")).r.status,
    404,
  );
  assert.equal(
    (
      await call(
        "/api/v1/enterprises",
        "POST",
        { name: "blocked" },
        { Origin: "https://evil.example" },
      )
    ).r.status,
    403,
  );
  assert.equal(
    (
      await call("/api/v1/projects/" + p.id, "PUT", {
        expectedVersion: 2,
        scene: {},
      })
    ).r.status,
    422,
  );
  assert.equal(
    (await call("/api/v1/payment-webhooks/sandbox", "POST", { eventId: "bad" }))
      .r.status,
    401,
  );
  await call("/api/v1/auth/logout", "POST", {});
  assert.equal((await call("/api/v1/me")).r.status, 401);
});
