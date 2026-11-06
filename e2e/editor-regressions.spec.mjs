import { test as base, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PerspectiveCamera, Vector3 } from "three";
import { seedQa } from "../scripts/staging/seed.mjs";
import { createApp } from "../src/server.mjs";
const test = base.extend({
  qa: async ({}, use) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qa-editor-"));
    const init = seedQa(root),
      { accounts } = JSON.parse(fs.readFileSync(init.accountsFile)),
      fixtures = JSON.parse(fs.readFileSync(init.fixtureFile));
    const app = createApp({ dataDir: root, environment: "isolated-qa" });
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    try {
      await use({
        url: "http://127.0.0.1:" + app.server.address().port,
        accounts,
        fixtures,
      });
    } finally {
      await new Promise((r) => app.server.close(r));
      app.store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
});
async function login(page, qa) {
  const a = qa.accounts.find((a) => a.username === "qa_designer");
  await page.goto(qa.url);
  await page.getByLabel("账号", { exact: true }).fill(a.username);
  await page.getByLabel("密码", { exact: true }).fill(a.password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "项目与空间", exact: true }),
  ).toBeVisible();
}
async function open(page, qa, name = "验收01·编辑保存") {
  await page.getByLabel("当前工作空间").selectOption(qa.fixtures.workspaces.x);
  await page
    .locator(".card")
    .filter({ has: page.getByRole("heading", { name, exact: true }) })
    .getByRole("button", { name: "打开空间", exact: true })
    .click();
  await expect(page.locator("#plan")).toBeVisible();
}
const save = (page) =>
  page.getByRole("button", { name: "保存", exact: true }).first();
test("设计师个人空库→企业产品添加→2D拖动→保存刷新仍在企业且位置保留", async ({
  page,
  qa,
}) => {
  await login(page, qa);
  await page.getByRole("button", { name: "创建项目", exact: true }).isVisible();
  await open(page, qa);
  await expect(page.locator("#plan rect")).toHaveCount(4);
  await page
    .getByRole("button", { name: "验收电竞椅 · ¥800", exact: true })
    .click();
  await page
    .getByRole("button", { name: "验收电竞椅 · ¥800", exact: true })
    .click();
  await expect(page.locator("#plan rect")).toHaveCount(6);
  const chairs = await page
    .locator("#plan rect")
    .evaluateAll((nodes) =>
      nodes.slice(-2).map((n) => [n.getAttribute("x"), n.getAttribute("y")]),
    );
  expect(chairs[0]).not.toEqual(chairs[1]);
  const desk = page.locator('#plan rect[data-object-id="desk"]'),
    before = Number(await desk.getAttribute("x")),
    box = await desk.boundingBox();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width * 0.2 + 35,
    box.y + box.height * 0.2 + 15,
    { steps: 6 },
  );
  await page.mouse.up();
  const after = Number(await desk.getAttribute("x"));
  expect(after).not.toBe(before);
  expect(Math.abs(after - before)).toBeLessThan(700);
  await save(page).click();
  await expect(page.getByRole("status")).toContainText("已保存到服务器");
  await page.reload();
  await expect(page.getByLabel("当前工作空间")).toHaveValue(
    qa.fixtures.workspaces.x,
  );
  await page
    .locator(".card")
    .filter({
      has: page.getByRole("heading", { name: "验收01·编辑保存", exact: true }),
    })
    .getByRole("button", { name: "打开空间" })
    .click();
  await expect(page.locator("#plan rect")).toHaveCount(6);
  await expect(
    page.locator('#plan rect[data-object-id="desk"]'),
  ).toHaveAttribute("x", String(after));
});
test("保存回包延迟期间继续添加家具不会丢失新修改", async ({ page, qa }) => {
  await login(page, qa);
  await open(page, qa);
  await page
    .getByRole("button", { name: "验收电竞椅 · ¥800", exact: true })
    .click();
  let release, seen;
  const gate = new Promise((r) => (release = r)),
    received = new Promise((r) => (seen = r));
  let delayed = false;
  await page.route(
    "**/api/v1/projects/" + qa.fixtures.projects.edit,
    async (route) => {
      if (route.request().method() === "PUT" && !delayed) {
        delayed = true;
        const response = await route.fetch();
        seen();
        await gate;
        await route.fulfill({ response });
      } else await route.continue();
    },
  );
  try {
    await save(page).click();
    await received;
    await expect(save(page)).toBeDisabled();
    await page
      .getByRole("button", { name: "验收电竞椅 · ¥800", exact: true })
      .click();
    await expect(page.locator("#plan rect")).toHaveCount(6);
    release();
    await expect(page.getByRole("status")).toContainText(
      "保存期间的新修改仍待保存",
    );
    await expect(page.locator("#plan rect")).toHaveCount(6);
    await save(page).click();
    await expect(page.getByRole("status")).toContainText("已保存到服务器");
    const response = await page.request.get(
      qa.url + "/api/v1/projects/" + qa.fixtures.projects.edit,
    );
    expect((await response.json()).data.scene.objects).toHaveLength(6);
  } finally {
    release();
  }
});
test("3D真实指针拖动家具会更新2D位置并持久化", async ({ page, qa }) => {
  await login(page, qa);
  await open(page, qa);
  const before = Number(
    await page.locator('#plan rect[data-object-id="desk"]').getAttribute("x"),
  );
  await page.getByRole("button", { name: "3D", exact: true }).click();
  const canvas = page.locator("#viewport canvas");
  await expect(canvas).toBeVisible();
  await page.getByRole("button", { name: "显示 / 隐藏墙体" }).click();
  const box = await canvas.boundingBox(),
    camera = new PerspectiveCamera(45, box.width / box.height, 0.01, 1000);
  camera.position.set(7, 7, 8);
  camera.lookAt(2, 1, 1.75);
  camera.updateMatrixWorld();
  const point = new Vector3(1.2, 0.75, 0.7).project(camera),
    x = box.x + ((point.x + 1) * box.width) / 2,
    y = box.y + ((1 - point.y) * box.height) / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 24, y + 10, { steps: 8 });
  await page.mouse.up();
  await page.getByRole("button", { name: "2D", exact: true }).click();
  const after = Number(
    await page.locator('#plan rect[data-object-id="desk"]').getAttribute("x"),
  );
  expect(after).not.toBe(before);
  await save(page).click();
  await expect(page.getByRole("status")).toContainText("已保存到服务器");
  const response = await page.request.get(
    qa.url + "/api/v1/projects/" + qa.fixtures.projects.edit,
  );
  expect(
    (await response.json()).data.scene.objects.find((o) => o.id === "desk").x,
  ).toBe(after + 700);
});
test("已提交方案在编辑器只读，拖动与添加均不能制造假编辑", async ({
  page,
  qa,
}) => {
  await login(page, qa);
  await open(page, qa, "验收02·自购交付");
  await expect(save(page)).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "验收电竞椅 · ¥800", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText(/只读方案 · v2/)).toBeVisible();
  const desk = page.locator('#plan rect[data-object-id="desk"]'),
    x = await desk.getAttribute("x"),
    box = await desk.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 50,
    box.y + box.height / 2 + 20,
  );
  await page.mouse.up();
  await expect(desk).toHaveAttribute("x", x);
});
test("切换企业时迟到的项目响应不会混入新工作空间", async ({ page, qa }) => {
  await login(page, qa);
  let release, seen;
  const gate = new Promise((r) => (release = r)),
    received = new Promise((r) => (seen = r));
  await page.route(
    "**/api/v1/workspaces/" + qa.fixtures.workspaces.x + "/projects",
    async (route) => {
      const response = await route.fetch();
      seen();
      await gate;
      await route.fulfill({ response });
    },
  );
  try {
    await page
      .getByLabel("当前工作空间")
      .selectOption(qa.fixtures.workspaces.x);
    await received;
    await page
      .getByLabel("当前工作空间")
      .selectOption(qa.fixtures.workspaces.y);
    await expect(
      page.getByRole("heading", { name: "同名项目·隔离验证", exact: true }),
    ).toBeVisible();
    release();
    await expect(
      page.getByRole("heading", { name: "验收01·编辑保存", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByLabel("当前工作空间")).toHaveValue(
      qa.fixtures.workspaces.y,
    );
  } finally {
    release();
  }
});

test("上传初始化回包期间切换企业，不会把原空间文件上传到新企业", async ({
  page,
  qa,
}) => {
  await login(page, qa);
  await page.getByRole("button", { name: "产品与模型", exact: true }).click();
  const json = Buffer.from(
      JSON.stringify({ asset: { version: "2.0" }, scenes: [{}] }),
    ),
    padded = Buffer.concat([
      json,
      Buffer.alloc((4 - (json.length % 4)) % 4, 32),
    ]),
    glb = Buffer.alloc(20 + padded.length);
  glb.write("glTF");
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(padded.length, 12);
  glb.write("JSON", 16);
  padded.copy(glb, 20);
  let release, seen;
  const gate = new Promise((r) => (release = r)),
    received = new Promise((r) => (seen = r));
  const parts = [];
  page.on("request", (r) => {
    if (r.method() === "PUT" && r.url().includes("/parts/"))
      parts.push(r.url());
  });
  await page.route(
    "**/api/v1/workspaces/" + qa.fixtures.workspaces.personal + "/uploads",
    async (route) => {
      const response = await route.fetch();
      seen();
      await gate;
      await route.fulfill({ response });
    },
  );
  try {
    await page.locator("input[type=file]").setInputFiles({
      name: "workspace-test.glb",
      mimeType: "model/gltf-binary",
      buffer: glb,
    });
    await page
      .getByRole("button", { name: "上传 / 续传", exact: true })
      .click();
    await received;
    await page
      .getByLabel("当前工作空间")
      .selectOption(qa.fixtures.workspaces.y);
    release();
    await expect(page.getByRole("status")).toContainText(
      "工作空间或账号已切换",
    );
    expect(parts).toHaveLength(0);
    for (const workspaceId of [
      qa.fixtures.workspaces.personal,
      qa.fixtures.workspaces.y,
    ]) {
      const r = await page.request.get(
        qa.url + "/api/v1/workspaces/" + workspaceId + "/assets",
      );
      expect((await r.json()).data).toHaveLength(0);
    }
  } finally {
    release();
  }
});
