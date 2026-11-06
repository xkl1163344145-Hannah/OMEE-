import { createReadStream } from "node:fs";
import crypto from "node:crypto";
export async function hashFile(file) {
  const hash = crypto.createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { size, sha256: hash.digest("hex") };
}
