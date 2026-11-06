import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultScene,
  findPlacement,
  validateScene,
} from "../src/geometry.mjs";
test("重复添加家具避开已有家具，凹房间和负坐标仍落在真实轮廓内", () => {
  const r = defaultScene().rooms[0];
  r.points = [
    { x: -2000, z: -2000 },
    { x: 2000, z: -2000 },
    { x: 2000, z: 0 },
    { x: 0, z: 0 },
    { x: 0, z: 1500 },
    { x: -2000, z: 1500 },
  ];
  r.wallIds = ["a", "b", "c", "d", "e", "f"];
  const dim = { width: 700, depth: 500, height: 750 };
  const p = findPlacement(r, dim);
  assert.ok(p);
  const first = {
    id: "first",
    roomId: r.id,
    source: "existing",
    ...dim,
    ...p,
    y: 0,
    rotation: 0,
  };
  const next = findPlacement(r, dim, [first]);
  assert.ok(next);
  assert.notDeepEqual(next, p);
  assert.equal(
    validateScene({
      schemaVersion: 1,
      unit: "mm",
      rooms: [r],
      objects: [first, { ...first, id: "second", ...next }],
    }).length,
    0,
  );
});
test("放不下或超层高时拒绝提供虚假落点", () => {
  const r = defaultScene().rooms[0];
  assert.equal(
    findPlacement(r, { width: 5000, depth: 1000, height: 700 }),
    null,
  );
  assert.equal(
    findPlacement(r, { width: 100, depth: 100, height: 3000 }),
    null,
  );
});
