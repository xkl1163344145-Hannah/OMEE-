// Persist millimetres; render metres. Geometry is independent of generated imagery.
export const defaultScene = () => ({
  schemaVersion: 1,
  unit: "mm",
  rooms: [
    {
      id: "room-1",
      height: 2800,
      points: [
        { x: 0, z: 0 },
        { x: 4000, z: 0 },
        { x: 4000, z: 3500 },
        { x: 0, z: 3500 },
      ],
      wallIds: ["w1", "w2", "w3", "w4"],
      openings: [],
      floorColor: "#c2aa88",
      wallColor: "#e8e6e1",
      ceilingColor: "#efefeb",
    },
  ],
  objects: [],
});
const cross = (a, b, c) =>
  (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
const on = (a, b, c) =>
  Math.abs(cross(a, b, c)) < 1e-6 &&
  c.x >= Math.min(a.x, b.x) &&
  c.x <= Math.max(a.x, b.x) &&
  c.z >= Math.min(a.z, b.z) &&
  c.z <= Math.max(a.z, b.z);
export function intersects(a, b, c, d) {
  return (
    (cross(a, b, c) * cross(a, b, d) < 0 &&
      cross(c, d, a) * cross(c, d, b) < 0) ||
    on(a, b, c) ||
    on(a, b, d) ||
    on(c, d, a) ||
    on(c, d, b)
  );
}
export function inside(p, pts) {
  if (pts.some((a, i) => on(a, pts[(i + 1) % pts.length], p))) return true;
  let r = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i],
      b = pts[j];
    if (
      a.z > p.z !== b.z > p.z &&
      p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x
    )
      r = !r;
  }
  return r;
}
const finite = (n) => Number.isSafeInteger(n) && Math.abs(n) <= 1000000;
export function validateScene(s) {
  const errors = [];
  const add = (code, message) => errors.push({ code, message });
  if (
    !s ||
    s.schemaVersion !== 1 ||
    s.unit !== "mm" ||
    !Array.isArray(s.rooms) ||
    !s.rooms.length ||
    s.rooms.length > 100 ||
    !Array.isArray(s.objects) ||
    s.objects.length > 5000 ||
    s.rooms.some((r) => !r || typeof r !== "object" || Array.isArray(r)) ||
    s.objects.some((o) => !o || typeof o !== "object" || Array.isArray(o))
  )
    return [
      {
        code: "SCHEMA",
        message: "场景必须为毫米制 schemaVersion=1，包含房间和对象数组",
      },
    ];
  const ids = new Set();
  const unique = (id) => {
    if (typeof id !== "string" || !id || ids.has(id))
      add("ID", "对象ID必须唯一");
    ids.add(id);
  };
  for (const r of s.rooms) {
    unique(r.id);
    const p = r.points;
    if (
      !Array.isArray(p) ||
      p.length < 3 ||
      p.length > 100 ||
      p.some((a) => !a || !finite(a.x) || !finite(a.z)) ||
      !finite(r.height) ||
      r.height < 100 ||
      r.height > 30000
    ) {
      add("ROOM", "房间轮廓或高度无效");
      continue;
    }
    if (!Array.isArray(r.wallIds) || r.wallIds.length !== p.length) {
      add("WALL_IDS", "墙段必须有稳定ID");
      continue;
    }
    r.wallIds.forEach(unique);
    let area = 0;
    for (let i = 0; i < p.length; i++) {
      const a = p[i],
        b = p[(i + 1) % p.length];
      area += a.x * b.z - b.x * a.z;
      if (Math.hypot(a.x - b.x, a.z - b.z) < 50)
        add("SHORT_WALL", "墙长不可小于50mm");
      for (let j = i + 1; j < p.length; j++) {
        if (j === i + 1 || (i === 0 && j === p.length - 1)) continue;
        if (intersects(a, b, p[j], p[(j + 1) % p.length]))
          add("SELF_INTERSECTION", "房间墙线自交或重叠");
      }
    }
    if (Math.abs(area) < 20000) add("AREA", "房间面积过小");
    if (
      !Array.isArray(r.openings) ||
      r.openings.some((o) => !o || typeof o !== "object")
    ) {
      add("OPENINGS", "门窗必须为数组");
      continue;
    }
    for (const o of r.openings) {
      unique(o.id);
      const i = r.wallIds.indexOf(o.wallId);
      if (
        i < 0 ||
        !["door", "window"].includes(o.kind) ||
        ![o.offset, o.width, o.height, o.sill].every(finite) ||
        o.offset < 0 ||
        o.width <= 0 ||
        o.height <= 0 ||
        o.sill < 0 ||
        o.sill + o.height > r.height ||
        o.offset + o.width >
          (i < 0
            ? 0
            : Math.hypot(
                p[i].x - p[(i + 1) % p.length].x,
                p[i].z - p[(i + 1) % p.length].z,
              ))
      )
        add("OPENING", "门窗超出墙面");
      for (const q of r.openings) {
        if (q === o) break;
        if (
          q.wallId === o.wallId &&
          o.offset < q.offset + q.width &&
          q.offset < o.offset + o.width &&
          o.sill < q.sill + q.height &&
          q.sill < o.sill + o.height
        )
          add("OPENING_OVERLAP", "门窗开洞重叠");
      }
    }
  }
  for (const o of s.objects) {
    unique(o.id);
    const r = s.rooms.find((r) => r.id === o.roomId);
    if (
      !r ||
      ![o.x, o.y, o.z, o.width, o.depth, o.height].every(finite) ||
      Math.min(o.width, o.depth, o.height) <= 0 ||
      !Number.isFinite(o.rotation) ||
      !["new", "existing"].includes(o.source) ||
      (o.source === "new" &&
        (typeof o.variantId !== "string" || typeof o.offerId !== "string"))
    ) {
      add("OBJECT", "家具引用、尺寸或变换无效");
      continue;
    }
    if (o.y < 0 || o.y + o.height > r.height)
      add("HEIGHT", "家具超出地面或天花板");
    const c = Math.cos(o.rotation),
      t = Math.sin(o.rotation),
      corners = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ].map(([x, z]) => ({
        x: o.x + ((x * o.width) / 2) * c - ((z * o.depth) / 2) * t,
        z: o.z + ((x * o.width) / 2) * t + ((z * o.depth) / 2) * c,
      }));
    if (
      Array.isArray(r.points) &&
      r.points.length >= 3 &&
      r.points.every((p) => finite(p.x) && finite(p.z))
    ) {
      if (corners.some((p) => !inside(p, r.points)))
        add("OUTSIDE", "家具超出房间");
      // Concave boundaries can cut an edge even if its endpoints are inside.
      for (let i = 0; i < 4; i++) {
        const a = corners[i],
          b = corners[(i + 1) % 4];
        if (!inside({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }, r.points))
          add("OUTSIDE", "家具穿过凹墙边界");
        for (let j = 0; j < r.points.length; j++) {
          const u = r.points[j],
            v = r.points[(j + 1) % r.points.length];
          if (
            cross(a, b, u) * cross(a, b, v) < 0 &&
            cross(u, v, a) * cross(u, v, b) < 0
          )
            add("OUTSIDE", "家具边缘穿墙");
        }
      }
    }
  }
  return errors;
}
