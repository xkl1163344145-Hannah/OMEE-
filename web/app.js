import { validateScene, findPlacement } from "/geometry.mjs";
const $ = (id) => document.getElementById(id),
  content = $("content");
let me = null,
  w = null,
  view = "projects",
  project = null,
  catalog = [],
  dirty = false,
  viewer = null,
  epoch = 0;
const notice = (s, error = false) => {
  $("notice").textContent = s;
  $("notice").className = error ? "error" : "";
};
const el = (tag, text = "", cls = "") => {
  const x = document.createElement(tag);
  x.textContent = text;
  if (cls) x.className = cls;
  return x;
};
const api = async (p, method = "GET", body) => {
  const r = await fetch("/api/v1" + p, {
      method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    }),
    j = await r.json();
  if (!r.ok) throw Error(j.error?.message || r.status);
  return j.data;
};
const run = (fn) => async (e) => {
  try {
    await fn(e);
  } catch (err) {
    notice(err.message, true);
  }
};
const button = (label, fn, cls = "") => {
  const b = el("button", label, cls);
  b.onclick = run(fn);
  return b;
};
const card = (title, parent = content) => {
  const c = el("div", "", "card");
  if (title) c.append(el("h2", title));
  parent.append(c);
  return c;
};
const money = (value) =>
  value == null
    ? "—"
    : new Intl.NumberFormat("zh-CN", {
        style: "currency",
        currency: "CNY",
      }).format(value / 100);
const workspaceKey = (userId) => "space-master:workspace:" + userId;
function rememberWorkspace() {
  try {
    localStorage.setItem(workspaceKey(me.user.id), w.id);
  } catch {}
}
function table(rows, fields, parent) {
  const t = el("table"),
    head = el("tr");
  for (const [, label] of fields) head.append(el("th", label));
  t.append(head);
  for (const row of rows) {
    const tr = el("tr");
    for (const [k, , format] of fields)
      tr.append(el("td", format ? format(row[k]) : String(row[k] ?? "")));
    t.append(tr);
  }
  parent.append(t);
  if (!rows.length) parent.append(el("p", "暂无记录"));
}
function form(parent, fields, onSubmit, label = "保存") {
  const f = el("form"),
    inputs = {};
  for (const [key, title, type = "text", options] of fields) {
    const l = el("label", title),
      i = el(type === "select" ? "select" : "input");
    if (type === "select") {
      for (const [value, name] of options) {
        const o = el("option", name);
        o.value = value;
        i.append(o);
      }
    } else {
      i.type = type;
      i.required = true;
      if (type === "number") {
        i.min = "0";
        i.step = "1";
      }
    }
    i.setAttribute("aria-label", title);
    i.name = key;
    i.autocomplete = type === "password" ? "new-password" : "off";
    inputs[key] = i;
    l.append(i);
    f.append(l);
  }
  const b = el("button", label, "primary");
  f.append(b);
  f.onsubmit = run(async (e) => {
    e.preventDefault();
    b.disabled = true;
    try {
      await onSubmit(
        Object.fromEntries(
          Object.entries(inputs).map(([k, i]) => [
            k,
            i.type === "number" ? Number(i.value) : i.value,
          ]),
        ),
        inputs,
      );
    } finally {
      b.disabled = false;
    }
  });
  parent.append(f);
  return inputs;
}
const title = (h, p) => {
  content.append(el("h1", h));
  if (p) content.append(el("p", p));
};
const ws = (part) => "/workspaces/" + w.id + "/" + part;
function clean() {
  viewer?.dispose();
  viewer = null;
  project = null;
  dirty = false;
  content.replaceChildren();
  notice("");
}
function confirmLeave() {
  return !dirty || confirm("当前有未保存的修改，确定离开？");
}
async function login() {
  clean();
  $("workspace").hidden = true;
  $("logout").hidden = true;
  $("identity").textContent = "";
  $("nav").replaceChildren();
  const c = card("登录空间大师");
  c.id = "login";
  c.append(el("p", "使用管理员为你开通的独立账号，进入自己的工作空间。"));
  form(
    c,
    [
      ["username", "账号"],
      ["password", "密码", "password"],
    ],
    async (j) => {
      await api("/auth/login", "POST", j);
      await start();
    },
    "登录",
  );
}
async function start() {
  me = await api("/me");
  let preferred;
  try {
    preferred = localStorage.getItem(workspaceKey(me.user.id));
  } catch {}
  w =
    me.workspaces.find((x) => x.id === w?.id) ||
    me.workspaces.find((x) => x.id === preferred) ||
    me.workspaces[0];
  if (!me.user.platformAdmin && view === "admin") view = "projects";
  rememberWorkspace();
  $("identity").textContent = me.user.username;
  $("workspace").hidden = false;
  $("logout").hidden = false;
  $("workspace").replaceChildren();
  for (const a of me.workspaces) {
    const o = el("option", a.name + " · " + a.role);
    o.value = a.id;
    $("workspace").append(o);
  }
  $("workspace").value = w.id;
  const nav = [
    ["projects", "项目与空间"],
    ["catalog", "产品与模型"],
    ["members", "成员与邀请"],
    ["customers", "客户管理"],
    ["reviews", "客户审阅"],
    ["orders", "销售订单"],
    ["purchases", "供应商接单"],
  ];
  if (me.user.platformAdmin) nav.push(["admin", "OMEE 总控"]);
  $("nav").replaceChildren();
  for (const [id, label] of nav) {
    const b = button(label, async () => {
      if (confirmLeave()) {
        view = id;
        await render();
      }
    });
    b.dataset.view = id;
    $("nav").append(b);
  }
  await render();
}
$("workspace").onchange = run(async (e) => {
  if (!confirmLeave()) {
    e.target.value = w.id;
    return;
  }
  epoch++;
  w = me.workspaces.find((x) => x.id === e.target.value);
  rememberWorkspace();
  await render();
});
$("logout").onclick = run(async () => {
  if (!confirmLeave()) return;
  epoch++;
  await api("/auth/logout", "POST", {});
  me = null;
  w = null;
  view = "projects";
  await login();
});
window.addEventListener("beforeunload", (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
async function render() {
  const n = ++epoch;
  clean();
  for (const b of $("nav").children)
    b.classList.toggle("active", b.dataset.view === view);
  const canManageCustomers = ["owner", "admin"].includes(w.role);
  if (view === "customers" && !canManageCustomers) view = "projects";
  for (const b of $("nav").children) {
    b.hidden = b.dataset.view === "customers" && !canManageCustomers;
    b.classList.toggle("active", b.dataset.view === view);
  }
  const pages = {
    projects: projectsPage,
    catalog: catalogPage,
    members: membersPage,
    customers: customersPage,
    reviews: reviewsPage,
    orders: ordersPage,
    purchases: purchasesPage,
    admin: adminPage,
  };
  await pages[view](n);
}
async function projectsPage(n) {
  title("项目与空间", "客户、场景、提交版本与交付记录在同一个项目中关联。");
  const rows = await api(ws("projects"));
  if (n !== epoch) return;
  if (!["owner", "admin", "designer"].includes(w.role)) {
    content.append(el("p", "当前岗位没有项目设计权限。"));
    return;
  }
  const c = card("创建项目");
  let customers = [];
  try {
    customers = await api(ws("customers"));
  } catch {}
  if (n !== epoch) return;
  form(
    c,
    [
      ["name", "项目名称"],
      [
        "customerId",
        "客户",
        "select",
        [["", "暂不关联"], ...customers.map((x) => [x.id, x.name])],
      ],
    ],
    async (j) => {
      await api(ws("projects"), "POST", j);
      await render();
    },
    "创建项目",
  );
  const grid = el("div", "", "grid");
  content.append(grid);
  for (const p of rows) {
    const c = card(p.name, grid);
    c.append(el("p", "版本 " + p.version + " · " + p.status));
    c.append(button("打开空间", () => editor(p.id), "primary"));
    if (["owner", "admin"].includes(w.role))
      c.append(
        button("转派设计师", async () => {
          const members = await api(ws("members"));
          const f = card("转派：" + p.name);
          form(
            f,
            [
              [
                "designerId",
                "设计师",
                "select",
                members
                  .filter(
                    (m) =>
                      m.status === "active" &&
                      ["owner", "admin", "designer"].includes(m.role),
                  )
                  .map((m) => [m.user_id, m.username]),
              ],
            ],
            async (j) => {
              await api("/projects/" + p.id + "/reassign", "POST", j);
              notice("项目已转派");
            },
          );
        }),
      );
  }
}
async function editor(id) {
  const openedWorkspace = w,
    openedEpoch = epoch;
  const p = await api("/projects/" + id);
  if (epoch !== openedEpoch || w.id !== openedWorkspace.id) return;
  if (p.workspace_id !== openedWorkspace.id) {
    throw Error("项目与当前工作空间不匹配，请从项目所属工作空间重新打开");
  }
  const cat = await api("/workspaces/" + p.workspace_id + "/catalog");
  if (epoch !== openedEpoch || w.id !== openedWorkspace.id) return;
  clean();
  const editorEpoch = ++epoch;
  const isCurrent = () => epoch === editorEpoch && project?.id === id;
  const editable = ["draft", "changes_requested"].includes(p.status);
  project = p;
  catalog = cat;
  title(
    p.name,
    "工作空间：" +
      openedWorkspace.name +
      " · 毫米精度 · 在2D中拖动家具 · 保存后生成新修订",
  );
  const bar = el("div", "", "tools");
  content.append(bar);
  let mode = "2d",
    draw = false,
    points = [],
    selected = null,
    history = [],
    future = [];
  let editSerial = 0,
    saving = false;
  let saveButton, forkButton;
  const mutationButton = (label, fn, cls = "") => {
    const b = button(label, fn, cls);
    b.disabled = !editable;
    return b;
  };
  const checkpoint = () => {
    if (!editable) throw Error("方案已提交或锁定，请等待审核或新建修订");
    editSerial++;
    history.push(structuredClone(project.scene));
    future = [];
    dirty = true;
  };
  const layout = el("div", "", "editor"),
    area = card("", layout),
    side = card("场景属性", layout);
  content.append(layout);
  const status = el("p", "", "muted");
  area.append(status);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = "plan";
  svg.setAttribute("viewBox", "-600 -600 6200 5200");
  area.append(svg);
  const viewport = el("div");
  viewport.id = "viewport";
  viewport.hidden = true;
  area.append(viewport);
  const info = el(
    "p",
    "线框表示无模型几何占位，红框表示加载失败。客户与普通设计师不会收到企业原件。",
    "muted",
  );
  area.append(info);
  const show = () => {
    const e = validateScene(project.scene);
    if (saveButton) saveButton.disabled = !editable || saving;
    status.textContent =
      (!editable ? "只读方案 · " : "") +
      "v" +
      project.version +
      " · " +
      project.status +
      " · " +
      (dirty ? "有未保存修改" : "已保存") +
      (e.length ? " · " + e.map((x) => x.message).join("；") : "");
    if (mode === "3d") {
      viewer?.update(project.scene, catalog, notice).catch((error) => {
        if (isCurrent()) notice("3D预览失败：" + error.message, true);
      });
      return;
    }
    svg.replaceChildren();
    const NS = svg.namespaceURI,
      node = (tag, attrs) => {
        const x = document.createElementNS(NS, tag);
        for (const [k, v] of Object.entries(attrs)) x.setAttribute(k, v);
        svg.append(x);
        return x;
      };
    for (const r of project.scene.rooms) {
      node("polygon", {
        points: r.points.map((p) => p.x + "," + p.z).join(" "),
        fill: r.floorColor || "#c2aa88",
        stroke: "#314650",
        "stroke-width": 45,
      });
      r.points.forEach((p, i) => {
        const b = r.points[(i + 1) % r.points.length];
        const text = node("text", {
          x: (p.x + b.x) / 2,
          y: (p.z + b.z) / 2 - 70,
          "text-anchor": "middle",
        });
        text.textContent = Math.round(Math.hypot(p.x - b.x, p.z - b.z)) + "mm";
        const c = node("circle", {
          cx: p.x,
          cy: p.z,
          r: 65,
          fill: "#50bfa3",
          class: "corner",
        });
        c.onpointerdown = (e) => {
          if (draw || !editable) return;
          drag = { room: r.id, index: i, moved: false };
          svg.setPointerCapture(e.pointerId);
          e.stopPropagation();
        };
      });
    }
    for (const o of project.scene.objects) {
      const rect = node("rect", {
        x: o.x - o.width / 2,
        y: o.z - o.depth / 2,
        width: o.width,
        height: o.depth,
        fill: selected === o.id ? "#4a8e81" : "#638489",
        stroke: "#27434a",
        "stroke-width": 20,
        transform: `rotate(${(o.rotation * 180) / Math.PI} ${o.x} ${o.z})`,
        "data-object-id": o.id,
      });
      rect.onpointerdown = (e) => {
        if (draw || !editable) return;
        selected = o.id;
        const p = position(e);
        drag = {
          object: o.id,
          offsetX: p.x - o.x,
          offsetZ: p.z - o.z,
          moved: false,
        };
        svg.setPointerCapture(e.pointerId);
        props();
        e.stopPropagation();
      };
      const txt = node("text", { x: o.x, y: o.z, "text-anchor": "middle" });
      txt.textContent =
        catalog.find((v) => v.id === o.variantId)?.name || "原有家具";
    }
    if (points.length)
      node("polyline", {
        points: points.map((p) => p.x + "," + p.z).join(" "),
        fill: "none",
        stroke: "#008875",
        "stroke-width": 30,
      });
  };
  let drag = null;
  const position = (e) => {
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(
      svg.getScreenCTM().inverse(),
    );
    return { x: Math.round(pt.x / 10) * 10, z: Math.round(pt.y / 10) * 10 };
  };
  svg.onpointermove = (e) => {
    if (!drag || !isCurrent()) return;
    const p = position(e);
    if (!drag.moved) {
      checkpoint();
      drag.moved = true;
    }
    if (drag.object) {
      const o = project.scene.objects.find((o) => o.id === drag.object);
      o.x = p.x - drag.offsetX;
      o.z = p.z - drag.offsetZ;
    } else
      project.scene.rooms.find((r) => r.id === drag.room).points[drag.index] =
        p;
    show();
  };
  svg.onpointerup = () => {
    if (draw || !drag) return;
    drag = null;
    props();
    show();
  };
  svg.onpointercancel = svg.onlostpointercapture = () => {
    if (drag) {
      drag = null;
      props();
      show();
    }
  };
  svg.onclick = (e) => {
    if (draw) {
      points.push(position(e));
      show();
    }
  };
  const props = () => {
    side.replaceChildren(el("h2", "场景属性"));
    const r = project.scene.rooms[0];
    form(
      side,
      [
        ["height", "层高 mm", "number"],
        ["floorColor", "地板颜色", "color"],
        ["wallColor", "墙面颜色", "color"],
      ],
      (j) => {
        checkpoint();
        r.height = j.height;
        r.floorColor = j.floorColor;
        r.wallColor = j.wallColor;
        show();
      },
    );
    const inputs = side.querySelectorAll("input");
    inputs[0].value = r.height;
    inputs[1].value = r.floorColor || "#c2aa88";
    inputs[2].value = r.wallColor || "#e8e6e1";
    const o = project.scene.objects.find((o) => o.id === selected);
    if (o) {
      const ip = form(
        side,
        [
          ["y", "离地高度 mm", "number"],
          ["rotation", "旋转 度", "number"],
        ],
        (j) => {
          checkpoint();
          o.y = j.y;
          o.rotation = (j.rotation * Math.PI) / 180;
          show();
        },
      );
      ip.y.value = o.y;
      ip.rotation.value = Math.round((o.rotation * 180) / Math.PI);
      ip.rotation.min = "-360";
      side.append(
        button("吸附天花板", () => {
          checkpoint();
          o.y = r.height - o.height;
          show();
        }),
        button("落地", () => {
          checkpoint();
          o.y = 0;
          show();
        }),
        button(
          "删除家具",
          () => {
            checkpoint();
            project.scene.objects = project.scene.objects.filter(
              (x) => x.id !== o.id,
            );
            selected = null;
            props();
            show();
          },
          "danger",
        ),
      );
    }
    const add = card("添加真实SKU", side);
    const availableProducts = catalog.filter((v) => v.offer_id);
    if (!availableProducts.length) {
      add.append(el("p", "此工作空间暂无可添加的产品。"));
      add.append(el("p", "当前空间：" + openedWorkspace.name, "muted"));
      if (catalog.length) {
        add.append(
          el("p", "已有产品尚未关联供给报价，请由产品管理员补齐。", "muted"),
        );
      } else {
        add.append(
          el(
            "p",
            "产品库按工作空间隔离。要测试预置家具，请返回项目列表，切换到验收企业X，打开“验收01·编辑保存”。",
            "muted",
          ),
        );
      }
      add.append(
        button("返回项目列表", async () => {
          if (confirmLeave()) await render();
        }),
      );
    }
    for (const v of availableProducts) {
      add.append(
        mutationButton(v.name + " · ¥" + v.sale_fen / 100, () => {
          const dimensions = {
            width: v.width_mm,
            depth: v.depth_mm,
            height: v.height_mm,
          };
          const pos = findPlacement(r, dimensions, project.scene.objects);
          if (!pos) throw Error("房间内没有足够的空位，请先移动家具或调整房间");
          checkpoint();
          const o = {
            id: crypto.randomUUID(),
            roomId: r.id,
            source: "new",
            variantId: v.id,
            offerId: v.offer_id,
            x: pos.x,
            y: 0,
            z: pos.z,
            width: v.width_mm,
            depth: v.depth_mm,
            height: v.height_mm,
            rotation: 0,
          };
          project.scene.objects.push(o);
          selected = o.id;
          props();
          show();
        }),
      );
    }
    const door = card("门窗开洞", side);
    form(
      door,
      [
        [
          "wallId",
          "所在墙",
          "select",
          r.wallIds.map((id, i) => [id, "墙 " + (i + 1)]),
        ],
        [
          "kind",
          "类型",
          "select",
          [
            ["door", "门"],
            ["window", "窗"],
          ],
        ],
        ["offset", "沿墙偏移mm", "number"],
        ["width", "开口宽mm", "number"],
        ["height", "开口高mm", "number"],
        ["sill", "离地mm", "number"],
      ],
      (j) => {
        checkpoint();
        r.openings.push({ id: crypto.randomUUID(), ...j });
        show();
      },
    );
    form(
      side,
      [
        [
          "wall",
          "墙段",
          "select",
          r.wallIds.map((id, i) => [String(i), "墙 " + (i + 1)]),
        ],
        ["length", "墙长mm", "number"],
      ],
      (j) => {
        checkpoint();
        const i = Number(j.wall),
          a = r.points[i],
          b = r.points[(i + 1) % r.points.length],
          len = Math.hypot(b.x - a.x, b.z - a.z);
        r.points[(i + 1) % r.points.length] = {
          x: Math.round(a.x + ((b.x - a.x) * j.length) / len),
          z: Math.round(a.z + ((b.z - a.z) * j.length) / len),
        };
        show();
      },
      "调整墙长",
    );
    if (!editable)
      for (const control of side.querySelectorAll("input,select,button")) {
        if (control.textContent !== "返回项目列表") control.disabled = true;
      }
  };
  bar.append(
    button("← 项目", async () => {
      if (confirmLeave()) await render();
    }),
    (saveButton = mutationButton(
      "保存",
      async () => {
        if (saving) return;
        if (draw) throw Error("请先完成或取消画墙");
        saving = true;
        show();
        const savedSerial = editSerial;
        const sent = structuredClone(project.scene);
        try {
          const saved = await api("/projects/" + id, "PUT", {
            expectedVersion: project.version,
            scene: sent,
          });
          if (!isCurrent()) return;
          if (savedSerial === editSerial) {
            project = saved;
            dirty = false;
          } else {
            project.version = saved.version;
            project.status = saved.status;
            dirty = true;
          }
          show();
          notice(
            dirty
              ? "已保存此前版本；保存期间的新修改仍待保存"
              : "已保存到服务器",
          );
        } finally {
          saving = false;
          if (isCurrent()) show();
        }
      },
      "primary",
    )),
    mutationButton("撤销", () => {
      if (history.length) {
        future.push(structuredClone(project.scene));
        project.scene = history.pop();
        editSerial++;
        dirty = true;
        props();
        show();
      }
    }),
    mutationButton("重做", () => {
      if (future.length) {
        history.push(structuredClone(project.scene));
        project.scene = future.pop();
        editSerial++;
        dirty = true;
        props();
        show();
      }
    }),
    mutationButton("画墙 / 闭合", () => {
      if (draw) {
        if (points.length < 3) throw Error("至少点选三个墙角");
        checkpoint();
        const r = project.scene.rooms[0];
        r.points = points;
        r.wallIds = points.map(() => crypto.randomUUID());
        r.openings = [];
        points = [];
        draw = false;
        props();
      } else {
        draw = true;
        points = [];
        notice("点击画布依次放置墙角，再次点击「画墙 / 闭合」完成");
      }
      show();
    }),
    button("2D", () => {
      mode = "2d";
      svg.style.display = "";
      viewport.hidden = true;
      show();
    }),
    button("3D", async () => {
      mode = "3d";
      svg.style.display = "none";
      viewport.hidden = false;
      if (!viewer) {
        const { Viewer } = await import("/viewer.bundle.js");
        if (!isCurrent()) return;
        viewer = new Viewer(
          viewport,
          editable
            ? {
                onSelect: (objectId) => {
                  if (!isCurrent()) return;
                  selected = objectId;
                  props();
                },
                onMove: (objectId, pos) => {
                  if (!isCurrent()) return;
                  const o = project.scene.objects.find(
                    (o) => o.id === objectId,
                  );
                  if (!o) return;
                  checkpoint();
                  o.x = pos.x;
                  o.z = pos.z;
                  selected = o.id;
                  props();
                  show();
                },
              }
            : {},
        );
      }
      show();
    }),
    button("显示 / 隐藏墙体", () => {
      if (viewer) {
        viewer.walls = !viewer.walls;
        show();
      }
    }),
    button("显示 / 隐藏顶面", () => {
      if (viewer) {
        viewer.ceiling = !viewer.ceiling;
        show();
      }
    }),
    mutationButton("生成提交快照", async () => {
      if (dirty || saving) throw Error("请先完成保存当前修改");
      await api("/projects/" + id + "/submit", "POST", {
        expectedVersion: project.version,
      });
      await render();
      notice("快照已提交，客户可在客户审阅中查看");
    }),
    (forkButton = button("新建修订", async () => {
      if (dirty) throw Error("请先保存修改");
      await api("/projects/" + id + "/fork", "POST", {
        expectedVersion: project.version,
      });
      await editor(id);
    })),
  );
  forkButton.disabled = !["finalized", "self_completed", "ordered"].includes(
    project.status,
  );
  props();
  show();
}
async function membersPage(n) {
  title(
    "成员与邀请",
    "企业邀请需本人接受；撤权即时生效，个人和其他企业的数据保留。",
  );
  const invites = await api("/invitations");
  if (n !== epoch) return;
  for (const i of invites) {
    const c = card(i.workspace_name + " 邀请你成为 " + i.role);
    c.append(
      button("接受邀请", async () => {
        await api("/invitations/" + i.id + "/accept", "POST", {});
        await start();
      }),
    );
  }
  const c = card("创建企业工作空间");
  form(
    c,
    [["name", "企业名称"]],
    async (j) => {
      await api("/enterprises", "POST", j);
      await start();
    },
    "创建企业",
  );
  if (!["owner", "admin"].includes(w.role) || w.type !== "enterprise") return;
  const f = card("邀请成员");
  form(
    f,
    [
      ["username", "已有账号"],
      [
        "role",
        "岗位",
        "select",
        [
          ["designer", "设计师"],
          ["admin", "管理员"],
          ["product_manager", "产品管理员"],
          ["finance", "财务"],
          ["viewer", "只读"],
        ],
      ],
    ],
    async (j) => {
      await api(ws("invitations"), "POST", j);
      notice("邀请已发出，对方登录后接受");
    },
    "发送邀请",
  );
  const rows = await api(ws("members"));
  if (n !== epoch) return;
  const list = card("企业成员");
  for (const m of rows) {
    const row = el("div", "", "row");
    row.append(el("p", m.username + " · " + m.role + " · " + m.status));
    if (m.role !== "owner" && m.status === "active")
      row.append(
        button(
          "撤销成员权限",
          async () => {
            await api(ws("members/" + m.user_id), "DELETE");
            await render();
          },
          "danger",
        ),
      );
    list.append(row);
  }
}
async function customersPage(n) {
  title("客户管理", "客户档案属于当前工作空间；绑定客户账号用于受限审阅。");
  const rows = await api(ws("customers"));
  if (n !== epoch) return;
  const c = card("新建客户");
  form(
    c,
    [
      ["name", "客户名称"],
      ["username", "客户账号"],
    ],
    async (j) => {
      await api(ws("customers"), "POST", j);
      await render();
    },
  );
  table(
    rows,
    [
      ["name", "姓名"],
      ["user_id", "账号ID"],
      ["id", "客户ID"],
    ],
    card("客户档案"),
  );
}
async function catalogPage(n) {
  title(
    "产品与模型",
    "文件、产品系列、真实SKU、供给报价分别保存。GLB上传成功后仍需视觉验收。",
  );
  const [rows, assets, families] = await Promise.all([
    api(ws("catalog")),
    api(ws("assets")),
    api(ws("families")),
  ]);
  if (n !== epoch) return;
  catalog = rows;
  table(
    rows,
    [
      ["sku", "SKU"],
      ["name", "产品"],
      ["width_mm", "宽mm"],
      ["depth_mm", "深mm"],
      ["height_mm", "高mm"],
      ["sale_fen", "售价", money],
      ["stock", "库存"],
    ],
    card("当前工作空间产品库"),
  );
  if (!["owner", "admin", "product_manager"].includes(w.role)) {
    const c = card("模型资产");
    table(
      assets,
      [
        ["name", "文件"],
        ["state", "状态"],
      ],
      c,
    );
    c.append(
      el("p", "当前岗位可使用本空间产品；上传模型和维护供给需产品管理员权限。"),
    );
    return;
  }
  const c = card("上传自包含 GLB");
  c.append(
    el(
      "p",
      "每片4MiB；如中断，重新选同一文件可查询已完成分片后续传。500MiB是接口上限，大文件仍需容量验收。",
    ),
  );
  const uploadWorkspaceId = w.id,
    uploadUserId = me.user.id;
  const checkUploadContext = () => {
    if (
      epoch !== n ||
      w?.id !== uploadWorkspaceId ||
      me?.user.id !== uploadUserId
    )
      throw Error("工作空间或账号已切换，请在原空间重新选择文件续传");
  };
  const file = el("input");
  file.type = "file";
  file.accept = ".glb";
  c.append(file);
  let last = null;
  c.append(
    button(
      "上传 / 续传",
      async () => {
        const f = file.files[0];
        if (!f) throw Error("请选择GLB文件");
        if (f.size > 500 * 1024 * 1024) throw Error("模型超过500MiB");
        checkUploadContext();
        const bytes = await f.arrayBuffer(),
          sha256 = Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          )
            .map((x) => x.toString(16).padStart(2, "0"))
            .join(""),
          key =
            "upload:" + uploadUserId + ":" + uploadWorkspaceId + ":" + sha256;
        checkUploadContext();
        last = localStorage.getItem(key);
        if (!last) {
          last = (
            await api("/workspaces/" + uploadWorkspaceId + "/uploads", "POST", {
              name: f.name,
              size: f.size,
              sha256,
              parts: Math.ceil(f.size / (4 * 1024 * 1024)),
            })
          ).id;
          localStorage.setItem(key, last);
        }
        checkUploadContext();
        const state = await api("/uploads/" + last);
        const done = new Set(state.completedParts.map((p) => p.part));
        for (let n = 0; n < state.parts; n++) {
          checkUploadContext();
          if (done.has(n)) continue;
          const r = await fetch("/api/v1/uploads/" + last + "/parts/" + n, {
            method: "PUT",
            body: f.slice(n * 4 * 1024 * 1024, (n + 1) * 4 * 1024 * 1024),
          });
          if (!r.ok) throw Error((await r.json()).error.message);
          notice("已上传 " + (n + 1) + " / " + state.parts);
        }
        checkUploadContext();
        await api("/uploads/" + last + "/complete", "POST", {});
        checkUploadContext();
        localStorage.removeItem(key);
        await render();
        notice("文件已存储，材质、尺寸和可编辑性尚待预览验证");
      },
      "primary",
    ),
  );
  table(
    assets,
    [
      ["name", "文件"],
      ["size", "字节"],
      ["state", "状态"],
      ["id", "资产ID"],
    ],
    c,
  );
  const fam = card("产品系列");
  form(fam, [["name", "系列名称"]], async (j) => {
    await api(ws("families"), "POST", j);
    await render();
  });
  const v = card("真实SKU");
  form(
    v,
    [
      ["familyId", "系列", "select", families.map((x) => [x.id, x.name])],
      ["sku", "SKU"],
      ["name", "产品名称"],
      ["width", "宽mm", "number"],
      ["depth", "深mm", "number"],
      ["height", "高mm", "number"],
      [
        "assetId",
        "模型",
        "select",
        [["", "无模型（显示线框）"], ...assets.map((a) => [a.id, a.name])],
      ],
    ],
    async (j) => {
      await api(ws("variants"), "POST", j);
      await render();
    },
  );
  const offer = card("供给与价格");
  form(
    offer,
    [
      [
        "variantId",
        "SKU",
        "select",
        rows
          .filter((v, i) => rows.findIndex((a) => a.id === v.id) === i)
          .map((x) => [x.id, x.sku]),
      ],
      ["supplierId", "供应商ID"],
      ["saleFen", "销售价（分）", "number"],
      ["costFen", "成本（分）", "number"],
      ["stock", "可用库存", "number"],
    ],
    async (j) => {
      await api(ws("offers"), "POST", {
        ...j,
        validUntil: Date.now() + 7 * 86400e3,
      });
      await render();
    },
  );
}
async function reviewsPage(n) {
  title("客户审阅", "只读提交版本 · 设计与BOM分项确认 · 双采购选择");
  const rows = await api("/submissions");
  if (n !== epoch) return;
  for (const r of rows) {
    const c = card(
      (r.projectName || "提交 " + r.id.slice(0, 8)) +
        " · v" +
        (r.version || "?") +
        " · " +
        r.state,
    );
    c.append(
      button("查看提交", async () => {
        const requestedEpoch = epoch;
        const a = await api("/submissions/" + r.id);
        if (epoch !== requestedEpoch) return;
        clean();
        ++epoch;
        title(a.projectName + " · v" + a.version, "版本哈希 " + a.hash);
        const x = card("冻结清单 · ¥" + a.bom.totalFen / 100);
        table(
          a.bom.lines,
          [
            ["sku", "SKU"],
            ["name", "名称"],
            ["quantity", "数量"],
            ["unitPriceFen", "销售单价", money],
            ["subtotalFen", "合计", money],
          ],
          x,
        );
        const plan = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "svg",
        );
        plan.id = "plan";
        const room = a.scene.rooms[0],
          maxX = Math.max(...room.points.map((p) => p.x)),
          maxZ = Math.max(...room.points.map((p) => p.z));
        plan.setAttribute("viewBox", `-300 -300 ${maxX + 600} ${maxZ + 600}`);
        const polygon = document.createElementNS(plan.namespaceURI, "polygon");
        polygon.setAttribute(
          "points",
          room.points.map((p) => p.x + "," + p.z).join(" "),
        );
        polygon.setAttribute("fill", room.floorColor || "#c2aa88");
        polygon.setAttribute("stroke", "#314650");
        polygon.setAttribute("stroke-width", "50");
        plan.append(polygon);
        for (const o of a.scene.objects) {
          const box = document.createElementNS(plan.namespaceURI, "rect");
          for (const [k, v] of Object.entries({
            x: o.x - o.width / 2,
            y: o.z - o.depth / 2,
            width: o.width,
            height: o.depth,
            fill: "#638489",
            transform: `rotate(${(o.rotation * 180) / Math.PI} ${o.x} ${o.z})`,
            "data-object-id": o.id,
          }))
            box.setAttribute(k, v);
          plan.append(box);
        }
        x.append(plan);
        x.append(
          el(
            "p",
            "平面预览；模型材质不作为此版本已验收能力。确认记录：" +
              a.approvals.map((x) => x.kind).join("、"),
          ),
        );
        const actions = el("div", "", "tools");
        x.append(actions);
        const review = (action) => async () => {
          await api("/submissions/" + a.id + "/review", "POST", {
            action,
            hash: a.hash,
          });
          await render();
        };
        if (r.customer_user_id === me.user.id && a.state === "client_review")
          actions.append(
            button("确认设计", review("design"), "primary"),
            button("确认BOM", review("bom"), "primary"),
            button("退回修改", review("changes")),
          );
        if (r.customer_user_id !== me.user.id && a.state === "client_approved")
          actions.append(
            button(
              "设计师终审",
              async () => {
                await api("/submissions/" + a.id + "/finalize", "POST", {});
                await render();
              },
              "primary",
            ),
          );
        if (r.customer_user_id === me.user.id && a.state === "finalized")
          for (const [choice, label] of [
            ["self", "自行采购并交付清单"],
            ["platform", "选择平台采购"],
          ])
            actions.append(
              button(
                label,
                async () => {
                  await api("/submissions/" + a.id + "/choice", "POST", {
                    choice,
                  });
                  await render();
                },
                "primary",
              ),
            );
        if (["self_completed", "ordered"].includes(a.state)) {
          const link = el("a", "下载CSV产品清单");
          link.href = "/api/v1/submissions/" + a.id + "/export";
          x.append(link);
        }
        form(
          card("批注"),
          [["body", "修改意见或说明"]],
          async (j) => {
            await api("/submissions/" + a.id + "/comments", "POST", j);
            notice("批注已保存");
          },
          "发布批注",
        );
        for (const comment of a.comments) content.append(el("p", comment.body));
        content.append(button("返回提交列表", render));
      }),
    );
  }
}
async function ordersPage(n) {
  title(
    "销售订单",
    "当前付款适配器仅为沙箱。真实支付、发票、退款与结算尚未接入。",
  );
  const rows = await api("/orders");
  if (n !== epoch) return;
  table(
    rows,
    [
      ["id", "订单"],
      ["amount_fen", "金额", money],
      ["currency", "币种"],
      ["status", "状态"],
    ],
    card("商品销售订单"),
  );
}
async function purchasesPage(n) {
  title("供应商接单", "只显示分配给当前供应商账号的采购单。");
  const rows = await api("/purchases");
  if (n !== epoch) return;
  for (const p of rows) {
    const c = card("采购单 " + p.id.slice(0, 8) + " · " + p.status);
    table(
      p.lines,
      [
        ["sku", "SKU"],
        ["name", "产品"],
        ["quantity", "数量"],
        ["unitCostFen", "供货单价", money],
      ],
      c,
    );
    if (["pending", "accepted"].includes(p.status))
      c.append(
        button(
          p.status === "pending" ? "接受采购单" : "确认发货",
          async () => {
            await api("/purchases/" + p.id + "/status", "POST", {
              status: p.status === "pending" ? "accepted" : "shipped",
            });
            await render();
          },
          "primary",
        ),
      );
  }
}
async function adminPage(n) {
  title("OMEE 总控", "平台身份管理与供应商注册；业务数据仍按归属和授权读取。");
  const users = await api("/admin/users");
  if (n !== epoch) return;
  const c = card("开通独立账号");
  form(
    c,
    [
      ["username", "账号"],
      ["password", "初始密码（至少12位）", "password"],
    ],
    async (j) => {
      await api("/users", "POST", j);
      await render();
    },
    "创建账号",
  );
  table(
    users,
    [
      ["username", "账号"],
      ["id", "用户ID"],
    ],
    c,
  );
  form(
    card("注册供应商主体"),
    [
      ["name", "供应商名称"],
      ["username", "供应商账号"],
    ],
    async (j) => {
      const s = await api("/admin/suppliers", "POST", j);
      notice("供应商ID：" + s.id);
    },
  );
  table(
    await api("/admin/suppliers"),
    [
      ["name", "供应商"],
      ["id", "供应商ID"],
    ],
    card("供应商"),
  );
  table(
    await api("/admin/audit"),
    [
      ["created_at", "时间"],
      ["action", "动作"],
      ["target", "对象"],
    ],
    card("最近审计"),
  );
}
try {
  await start();
} catch {
  await login();
}
