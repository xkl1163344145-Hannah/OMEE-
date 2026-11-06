import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { uid, fail, hash } from "./domain.mjs";
export class Assets {
  constructor(d, dir) {
    this.d = d;
    this.dir = dir;
    this.locks = new Set();
    d.s.db.exec(
      `CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),actor_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,size INTEGER NOT NULL,hash TEXT NOT NULL,parts INTEGER NOT NULL,status TEXT NOT NULL); CREATE TABLE IF NOT EXISTS upload_parts(upload_id TEXT REFERENCES uploads(id),part INTEGER,size INTEGER NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(upload_id,part));`,
    );
  }
  async init(u, w, j) {
    this.d.access(u, w, ["owner", "admin", "product_manager"]);
    if (
      !Number.isSafeInteger(j.size) ||
      j.size < 20 ||
      j.size > 500 * 1024 * 1024 ||
      !Number.isInteger(j.parts) ||
      j.parts !== Math.ceil(j.size / (4 * 1024 * 1024)) ||
      !/^[a-f0-9]{64}$/.test(j.sha256) ||
      typeof j.name !== "string" ||
      !j.name.toLowerCase().endsWith(".glb") ||
      j.name.length > 160
    )
      fail(422, "UPLOAD", "一期仅支持自包含GLB；每片4MiB，总大小上限500MiB");
    const id = uid();
    await fs.mkdir(path.join(this.dir, "tmp", id), {
      recursive: true,
      mode: 0o700,
    });
    this.d.s.tx(() => {
      this.d.s.run(
        "INSERT INTO uploads VALUES(?,?,?,?,?,?,?,'uploading')",
        id,
        w,
        u.id,
        j.name,
        j.size,
        j.sha256,
        j.parts,
      );
      this.d.audit(u, "upload.init", id);
    });
    return { id, chunkSize: 4 * 1024 * 1024 };
  }
  get(u, id) {
    const a = this.d.s.get("SELECT * FROM uploads WHERE id=?", id);
    if (!a) fail(404, "UPLOAD", "上传不存在");
    this.d.access(u, a.workspace_id, ["owner", "admin", "product_manager"]);
    if (a.actor_id !== u.id) fail(403, "UPLOAD", "上传属于其他操作人");
    return a;
  }
  status(u, id) {
    const a = this.get(u, id);
    return {
      ...a,
      completedParts: this.d.s.all(
        "SELECT part,size,hash FROM upload_parts WHERE upload_id=?",
        id,
      ),
    };
  }
  async part(u, id, n, bytes) {
    let a = this.get(u, id);
    if (
      a.status !== "uploading" ||
      !Number.isInteger(n) ||
      n < 0 ||
      n >= a.parts ||
      bytes.length !== Math.min(4 * 1024 * 1024, a.size - n * 4 * 1024 * 1024)
    )
      fail(422, "PART", "分片序号、大小或上传状态错误");
    const key = id + ":" + n;
    if (this.locks.has(key) || this.locks.has(id))
      fail(409, "UPLOAD_BUSY", "分片正在写入");
    this.locks.add(key);
    try {
      const h = hash(bytes),
        old = this.d.s.get(
          "SELECT * FROM upload_parts WHERE upload_id=? AND part=?",
          id,
          n,
        );
      if (old) {
        if (old.hash !== h) fail(409, "PART_CONFLICT", "已上传分片内容不一致");
        return { part: n, sha256: h };
      }
      const file = path.join(this.dir, "tmp", id, String(n));
      await fs.writeFile(file, bytes, { mode: 0o600 });
      this.d.s.tx(() => {
        a = this.get(u, id);
        if (a.status !== "uploading") fail(409, "UPLOAD", "状态已改变");
        this.d.s.run(
          "INSERT INTO upload_parts VALUES(?,?,?,?)",
          id,
          n,
          bytes.length,
          h,
        );
      });
      return { part: n, sha256: h };
    } finally {
      this.locks.delete(key);
    }
  }
  async complete(u, id) {
    const a = this.get(u, id);
    if (a.status === "completed") return { id };
    if (
      this.locks.has(id) ||
      [...this.locks].some((k) => k.startsWith(id + ":"))
    )
      fail(409, "UPLOAD_BUSY", "上传仍在写入");
    this.locks.add(id);
    const dest = path.join(this.dir, id + ".glb"),
      temp = dest + ".assembling";
    try {
      const parts = this.d.s.all(
        "SELECT * FROM upload_parts WHERE upload_id=? ORDER BY part",
        id,
      );
      if (parts.length !== a.parts) fail(409, "INCOMPLETE", "分片尚未齐全");
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      await fs.rm(temp, { force: true });
      const h = crypto.createHash("sha256"),
        root = this.dir;
      async function* stream() {
        for (const p of parts) {
          for await (const chunk of createReadStream(
            path.join(root, "tmp", id, String(p.part)),
          )) {
            h.update(chunk);
            yield chunk;
          }
        }
      }
      await pipeline(
        stream.call(this),
        createWriteStream(temp, { flags: "wx", mode: 0o600 }),
      );
      if (h.digest("hex") !== a.hash) fail(422, "HASH", "完整文件散列不匹配");
      const fd = await fs.open(temp, "r");
      try {
        const header = Buffer.alloc(20);
        await fd.read(header, 0, 20, 0);
        const len = header.readUInt32LE(12);
        if (
          header.toString("ascii", 0, 4) !== "glTF" ||
          header.readUInt32LE(4) !== 2 ||
          header.readUInt32LE(8) !== a.size ||
          header.toString("ascii", 16, 20) !== "JSON" ||
          len < 2 ||
          len > 8 * 1024 * 1024 ||
          len + 20 > a.size ||
          len % 4
        )
          fail(422, "GLB", "GLB头或JSON块不合法");
        const bytes = Buffer.alloc(len);
        await fd.read(bytes, 0, len, 20);
        let gltf;
        try {
          gltf = JSON.parse(bytes.toString("utf8"));
        } catch {
          fail(422, "GLB", "GLB JSON损坏");
        }
        if (
          gltf.asset?.version !== "2.0" ||
          [...(gltf.buffers || []), ...(gltf.images || [])].some(
            (x) => x.uri && !x.uri.startsWith("data:"),
          )
        )
          fail(
            422,
            "GLB_DEPENDENCY",
            "GLB含外部依赖或版本不支持，请嵌入纹理与缓冲区",
          );
      } finally {
        await fd.close();
      }
      await fs.rename(temp, dest);
      this.d.s.tx(() => {
        this.get(u, id);
        this.d.s.run(
          "INSERT INTO assets VALUES(?,?,?,?,?,'stored_unverified','glb',?)",
          id,
          a.workspace_id,
          a.name,
          a.hash,
          a.size,
          u.id,
        );
        this.d.s.run("UPDATE uploads SET status='completed' WHERE id=?", id);
        this.d.audit(u, "asset.stored", id);
      });
      await fs.rm(path.join(this.dir, "tmp", id), {
        recursive: true,
        force: true,
      });
      return {
        id,
        state: "stored_unverified",
        sha256: a.hash,
        note: "文件已保存；视觉材质与比例仍需真实预览验收",
      };
    } catch (e) {
      await fs.rm(temp, { force: true });
      throw e;
    } finally {
      this.locks.delete(id);
    }
  }
  raw(u, id) {
    const a = this.d.s.get("SELECT * FROM assets WHERE id=?", id);
    if (!a) fail(404, "ASSET", "资产不存在");
    this.d.access(u, a.workspace_id, ["owner", "admin", "product_manager"]);
    this.d.audit(u, "asset.original.read", id);
    return path.join(this.dir, id + ".glb");
  }
}
