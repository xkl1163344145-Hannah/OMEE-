import { test, expect } from "@playwright/test";
test("真实浏览器：建客户和项目、画异形墙、保存刷新、3D、客户双确认、自购导出", async ({
  page,
  browser,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByLabel("账号", { exact: true }).fill("e2eadmin");
  await page.getByLabel("密码", { exact: true }).fill("isolated-e2e-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "项目与空间", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "OMEE 总控" }).click();
  await page.getByLabel("账号", { exact: true }).fill("client-e2e");
  await page
    .getByLabel("初始密码（至少12位）")
    .fill("isolated-client-password");
  await page.getByRole("button", { name: "创建账号" }).click();
  await expect(
    page.getByRole("cell", { name: "client-e2e", exact: true }),
  ).toBeVisible();
  // Seed real catalog data through authenticated API; placement and review remain browser actions.
  const post = async (p, data) => {
    const r = await page.request.post("/api/v1" + p, { data });
    expect(r.ok()).toBeTruthy();
    return (await r.json()).data;
  };
  const current = (await (await page.request.get("/api/v1/me")).json()).data;
  const workspaceId = current.workspaces[0].id;
  await post("/users", {
    username: "supplier-e2e",
    password: "isolated-supplier-password",
  });
  const supplier = await post("/admin/suppliers", {
    username: "supplier-e2e",
    name: "验收供货商",
  });
  const family = await post("/workspaces/" + workspaceId + "/families", {
    name: "验收系列",
  });
  const variant = await post("/workspaces/" + workspaceId + "/variants", {
    familyId: family.id,
    sku: "E2E-DESK",
    name: "验收桌",
    width: 1000,
    depth: 600,
    height: 750,
  });
  await post("/workspaces/" + workspaceId + "/offers", {
    variantId: variant.id,
    supplierId: supplier.id,
    saleFen: 125000,
    costFen: 80000,
    stock: 10,
    validUntil: Date.now() + 86400e3,
  });
  await page.getByRole("button", { name: "客户管理", exact: true }).click();
  await page.getByLabel("客户名称").fill("测试客户");
  await page.getByLabel("客户账号").fill("client-e2e");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "测试客户", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "项目与空间", exact: true }).click();
  await page.getByLabel("项目名称").fill("浏览器异形房间");
  await page
    .getByLabel("客户", { exact: true })
    .selectOption({ label: "测试客户" });
  await page.getByRole("button", { name: "创建项目" }).click();
  await page.getByRole("button", { name: "打开空间" }).click();
  await expect(page.locator("#plan")).toBeVisible();
  await page.getByRole("button", { name: "画墙 / 闭合" }).click();
  const svg = page.locator("#plan"),
    box = await svg.boundingBox();
  for (const [x, y] of [
    [0.2, 0.2],
    [0.7, 0.2],
    [0.7, 0.55],
    [0.5, 0.55],
    [0.5, 0.8],
    [0.2, 0.8],
  ])
    await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
  await page.getByRole("button", { name: "画墙 / 闭合" }).click();
  await page
    .getByRole("button", { name: "验收桌 · ¥1250", exact: true })
    .click();
  const furniture = page.locator("#plan rect");
  const rectBox = await furniture.boundingBox();
  const target = await page.locator("#plan").evaluate((svg) => {
    const corners = [...svg.querySelectorAll("circle")];
    const x =
      Math.min(...corners.map((c) => Number(c.getAttribute("cx")))) + 700;
    const z =
      Math.min(...corners.map((c) => Number(c.getAttribute("cy")))) + 500;
    const p = new DOMPoint(x, z).matrixTransform(svg.getScreenCTM());
    return { x: p.x, y: p.y };
  });
  await page.mouse.move(
    rectBox.x + rectBox.width / 2,
    rectBox.y + rectBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 8 });
  await page.mouse.up();
  await page.getByRole("button", { name: "保存", exact: true }).first().click();
  await expect(page.getByRole("status")).toContainText("已保存到服务器");
  await page.reload();
  await page.getByRole("button", { name: "打开空间" }).click();
  await expect(page.locator("#plan circle")).toHaveCount(6);
  await expect(page.locator("#plan rect")).toHaveCount(1);
  await page.getByRole("button", { name: "3D", exact: true }).click();
  await expect(page.locator("#viewport canvas")).toBeVisible();
  await expect(page.locator("#plan")).toBeHidden();
  await page.getByRole("button", { name: "显示 / 隐藏墙体" }).click();
  await page.screenshot({ path: "test-results/editor-3d.png", fullPage: true });
  await page.getByRole("button", { name: "显示 / 隐藏顶面" }).click();
  await page.getByRole("button", { name: "生成提交快照" }).click();
  await expect(page.getByRole("status")).toContainText("快照已提交");
  const ctx = await browser.newContext();
  const client = await ctx.newPage();
  await client.goto("/");
  await client.getByLabel("账号", { exact: true }).fill("client-e2e");
  await client
    .getByLabel("密码", { exact: true })
    .fill("isolated-client-password");
  await client.getByRole("button", { name: "登录", exact: true }).click();
  await client.getByRole("button", { name: "客户审阅", exact: true }).click();
  await client.getByRole("button", { name: "查看提交" }).click();
  await expect(
    client.getByRole("cell", { name: "E2E-DESK", exact: true }),
  ).toBeVisible();
  await expect(
    client.getByRole("heading", { name: "冻结清单 · ¥1250" }),
  ).toBeVisible();
  await client.getByRole("button", { name: "确认设计", exact: true }).click();
  await client.getByRole("button", { name: "查看提交" }).click();
  await client.getByRole("button", { name: "确认BOM", exact: true }).click();
  await page.getByRole("button", { name: "客户审阅", exact: true }).click();
  await page.getByRole("button", { name: "查看提交" }).click();
  await page.getByRole("button", { name: "设计师终审", exact: true }).click();
  await client.reload();
  await client.getByRole("button", { name: "客户审阅", exact: true }).click();
  await client.getByRole("button", { name: "查看提交" }).click();
  await client.getByRole("button", { name: "自行采购并交付清单" }).click();
  await client.getByRole("button", { name: "查看提交" }).click();
  await expect(
    client.getByRole("link", { name: "下载CSV产品清单" }),
  ).toBeVisible();
  const exported = await client.request.get(
    await client
      .getByRole("link", { name: "下载CSV产品清单" })
      .getAttribute("href"),
  );
  expect(await exported.text()).toContain("E2E-DESK");
  expect(await exported.text()).not.toContain("80000");
  await client.screenshot({
    path: "test-results/client-self-purchase.png",
    fullPage: true,
  });
  await client.getByRole("button", { name: "销售订单", exact: true }).click();
  await expect(client.getByText("暂无记录")).toBeVisible();
  expect(errors).toEqual([]);
  await ctx.close();
});
