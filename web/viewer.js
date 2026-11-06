import * as T from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
export class Viewer {
  constructor(host, { onSelect, onMove } = {}) {
    this.host = host;
    this.renderer = new T.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.renderer.toneMapping = T.ACESFilmicToneMapping;
    this.scene = new T.Scene();
    this.scene.background = new T.Color("#e8e6e0");
    this.camera = new T.PerspectiveCamera(45, 1, 0.01, 1000);
    this.camera.position.set(7, 7, 8);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(2, 1, 1.75);
    this.controls.update();
    this.scene.add(new T.HemisphereLight(0xffffff, 0x8a8175, 2));
    const sun = new T.DirectionalLight(0xffffff, 3);
    sun.position.set(4, 8, 3);
    this.scene.add(sun);
    this.group = new T.Group();
    this.scene.add(this.group);
    host.append(this.renderer.domElement);
    this.resize = new ResizeObserver(() => this.render());
    this.resize.observe(host);
    this.controls.addEventListener("change", () => this.render());
    this.ceiling = false;
    this.walls = true;
    this.generation = 0;
    this.disposed = false;
    this.objects = new Map();
    this.raycaster = new T.Raycaster();
    this.raycaster.params.Line.threshold = 0.08;
    const canvas = this.renderer.domElement;
    const cast = (e) => {
      const rect = canvas.getBoundingClientRect();
      this.raycaster.setFromCamera(
        new T.Vector2(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          (-(e.clientY - rect.top) / rect.height) * 2 + 1,
        ),
        this.camera,
      );
    };
    const finish = (cancel) => {
      const drag = this.drag;
      if (!drag) return;
      this.drag = null;
      this.controls.enabled = true;
      if (canvas.hasPointerCapture(drag.pointerId))
        canvas.releasePointerCapture(drag.pointerId);
      if (cancel) {
        drag.root.position.copy(drag.original);
        this.render();
        return;
      }
      const pos = {
        x: Math.round((drag.root.position.x * 1000) / 10) * 10,
        z: Math.round((drag.root.position.z * 1000) / 10) * 10,
      };
      if (
        pos.x !== Math.round(drag.original.x * 1000) ||
        pos.z !== Math.round(drag.original.z * 1000)
      )
        onMove?.(drag.id, pos);
    };
    this.down = (e) => {
      if (!onMove || e.button !== 0 || this.disposed) return;
      cast(e);
      const hits = this.raycaster.intersectObjects(
        [...this.objects.values()],
        true,
      );
      if (!hits.length) return;
      let root = hits[0].object;
      while (root && !root.userData.objectId) root = root.parent;
      if (!root) return;
      const plane = new T.Plane(new T.Vector3(0, 1, 0), -hits[0].point.y),
        point = new T.Vector3();
      if (!this.raycaster.ray.intersectPlane(plane, point)) return;
      this.drag = {
        id: root.userData.objectId,
        root,
        plane,
        original: root.position.clone(),
        offset: point.clone().sub(root.position),
        pointerId: e.pointerId,
      };
      this.controls.enabled = false;
      canvas.setPointerCapture(e.pointerId);
      onSelect?.(root.userData.objectId);
      e.stopImmediatePropagation();
      e.preventDefault();
    };
    this.move = (e) => {
      if (!this.drag) return;
      cast(e);
      const point = new T.Vector3();
      if (this.raycaster.ray.intersectPlane(this.drag.plane, point)) {
        this.drag.root.position.x = point.x - this.drag.offset.x;
        this.drag.root.position.z = point.z - this.drag.offset.z;
        this.render();
      }
      e.stopImmediatePropagation();
      e.preventDefault();
    };
    this.up = (e) => {
      if (!this.drag) return;
      finish(false);
      e.stopImmediatePropagation();
      e.preventDefault();
    };
    this.cancel = () => finish(true);
    canvas.addEventListener("pointerdown", this.down, true);
    canvas.addEventListener("pointermove", this.move, true);
    canvas.addEventListener("pointerup", this.up, true);
    canvas.addEventListener("pointercancel", this.cancel, true);
    canvas.addEventListener("lostpointercapture", this.cancel, true);
  }
  render() {
    const w = this.host.clientWidth,
      h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
  }
  clear() {
    this.cancel?.();
    this.objects?.clear();
    for (const child of [...this.group.children]) {
      child.traverse((o) => {
        o.geometry?.dispose();
        if (o.material)
          for (const m of Array.isArray(o.material)
            ? o.material
            : [o.material]) {
            for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
            m.dispose();
          }
      });
      this.group.remove(child);
    }
  }
  async update(scene, catalog, notice) {
    if (this.disposed) return;
    const generation = ++this.generation;
    this.clear();
    for (const r of scene.rooms) {
      const shape = new T.Shape();
      r.points.forEach((p, i) =>
        i
          ? shape.lineTo(p.x / 1000, -p.z / 1000)
          : shape.moveTo(p.x / 1000, -p.z / 1000),
      );
      shape.closePath();
      const floor = new T.Mesh(
        new T.ShapeGeometry(shape),
        new T.MeshStandardMaterial({
          color: r.floorColor || "#b69b7b",
          side: T.DoubleSide,
          roughness: 0.8,
        }),
      );
      floor.rotation.x = -Math.PI / 2;
      this.group.add(floor);
      if (this.ceiling) {
        const ceiling = floor.clone();
        ceiling.geometry = floor.geometry.clone();
        ceiling.material = new T.MeshStandardMaterial({
          color: r.ceilingColor || "#eeeeea",
          side: T.DoubleSide,
        });
        ceiling.position.y = r.height / 1000;
        this.group.add(ceiling);
      }
      if (this.walls)
        r.points.forEach((a, i) => {
          const b = r.points[(i + 1) % r.points.length],
            len = Math.hypot(a.x - b.x, a.z - b.z),
            opens = r.openings.filter((o) => o.wallId === r.wallIds[i]);
          const edges = [
            0,
            len,
            ...opens.flatMap((o) => [o.offset, o.offset + o.width]),
          ].sort((a, b) => a - b);
          for (let k = 0; k < edges.length - 1; k++) {
            const x = edges[k],
              end = edges[k + 1],
              middle = (x + end) / 2;
            const blocked = opens
              .filter((o) => o.offset < middle && o.offset + o.width > middle)
              .map((o) => [o.sill, o.sill + o.height])
              .sort((a, b) => a[0] - b[0]);
            const bands = [];
            let y = 0;
            for (const [bottom, top] of blocked) {
              if (bottom > y) bands.push([y, bottom]);
              y = Math.max(y, top);
            }
            if (y < r.height) bands.push([y, r.height]);
            for (const [bottom, top] of bands) {
              const mesh = new T.Mesh(
                new T.BoxGeometry((end - x) / 1000, (top - bottom) / 1000, 0.1),
                new T.MeshStandardMaterial({
                  color: r.wallColor || "#e8e6e1",
                  roughness: 0.9,
                }),
              );
              mesh.position.set(
                (a.x + ((b.x - a.x) * middle) / len) / 1000,
                (bottom + top) / 2000,
                (a.z + ((b.z - a.z) * middle) / len) / 1000,
              );
              mesh.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
              this.group.add(mesh);
            }
          }
        });
    }
    this.render();
    for (const o of scene.objects) {
      if (this.disposed || generation !== this.generation) return;
      const v = catalog.find((v) => v.id === o.variantId),
        asset = v?.asset_id;
      if (asset) {
        try {
          const response = await fetch("/api/v1/assets/" + asset + "/original");
          if (!response.ok)
            throw Error("没有原件权限；受限展示派生模型尚待接入");
          const gltf = await new GLTFLoader().parseAsync(
            await response.arrayBuffer(),
            "",
          );
          if (generation !== this.generation || this.disposed) {
            gltf.scene.traverse((o) => {
              o.geometry?.dispose();
              for (const m of o.material
                ? Array.isArray(o.material)
                  ? o.material
                  : [o.material]
                : []) {
                for (const value of Object.values(m))
                  if (value?.isTexture) value.dispose();
                m.dispose();
              }
            });
            return;
          }
          const model = gltf.scene,
            box = new T.Box3().setFromObject(model),
            size = box.getSize(new T.Vector3());
          if (Math.min(size.x, size.y, size.z) <= 1e-8)
            throw Error("模型包围盒无效");
          const factor = o.height / 1000 / size.y;
          const ratio = Math.max(
            Math.abs(size.x * factor - o.width / 1000) / (o.width / 1000),
            Math.abs(size.z * factor - o.depth / 1000) / (o.depth / 1000),
          );
          if (ratio > 0.15)
            notice("模型与SKU宽深比例偏差超过15%，已保留模型比例，请核实尺寸");
          model.scale.setScalar(factor);
          const scaled = new T.Box3().setFromObject(model),
            center = scaled.getCenter(new T.Vector3());
          model.position.set(-center.x, -scaled.min.y, -center.z);
          const root = new T.Group();
          root.add(model);
          root.position.set(o.x / 1000, o.y / 1000, o.z / 1000);
          root.rotation.y = -o.rotation;
          root.userData.objectId = o.id;
          this.objects.set(o.id, root);
          this.group.add(root);
        } catch (e) {
          if (this.disposed || generation !== this.generation) return;
          notice("模型预览失败：" + e.message);
          this.outline(o, "#e35555");
        }
      } else this.outline(o, "#709692");
    }
    this.render();
  }
  outline(o, color) {
    const box = new T.BoxGeometry(
      o.width / 1000,
      o.height / 1000,
      o.depth / 1000,
    );
    const root = new T.Group();
    root.add(
      new T.LineSegments(
        new T.EdgesGeometry(box),
        new T.LineBasicMaterial({ color }),
      ),
    );
    // A transparent hit target makes the whole displayed box draggable, not just its thin edges.
    root.add(
      new T.Mesh(
        box,
        new T.MeshBasicMaterial({
          transparent: true,
          opacity: 0,
          depthWrite: false,
          colorWrite: false,
        }),
      ),
    );
    root.position.set(o.x / 1000, (o.y + o.height / 2) / 1000, o.z / 1000);
    root.rotation.y = -o.rotation;
    root.userData.objectId = o.id;
    this.objects.set(o.id, root);
    this.group.add(root);
  }
  dispose() {
    this.disposed = true;
    this.generation++;
    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointerdown", this.down, true);
    canvas.removeEventListener("pointermove", this.move, true);
    canvas.removeEventListener("pointerup", this.up, true);
    canvas.removeEventListener("pointercancel", this.cancel, true);
    canvas.removeEventListener("lostpointercapture", this.cancel, true);
    this.resize.disconnect();
    this.controls.dispose();
    this.clear();
    this.renderer.dispose();
    this.host.replaceChildren();
  }
}
