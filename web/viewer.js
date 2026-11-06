import * as T from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
export class Viewer {
  constructor(host) {
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
    for (const o of scene.objects) {
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
          if (generation !== this.generation) return;
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
          this.group.add(root);
        } catch (e) {
          notice("模型预览失败：" + e.message);
          this.outline(o, "#e35555");
        }
      } else this.outline(o, "#709692");
    }
    this.render();
  }
  outline(o, color) {
    const geometry = new T.EdgesGeometry(
      new T.BoxGeometry(o.width / 1000, o.height / 1000, o.depth / 1000),
    );
    const mesh = new T.LineSegments(
      geometry,
      new T.LineBasicMaterial({ color }),
    );
    mesh.position.set(o.x / 1000, (o.y + o.height / 2) / 1000, o.z / 1000);
    mesh.rotation.y = -o.rotation;
    this.group.add(mesh);
  }
  dispose() {
    this.generation++;
    this.resize.disconnect();
    this.controls.dispose();
    this.clear();
    this.renderer.dispose();
    this.host.replaceChildren();
  }
}
