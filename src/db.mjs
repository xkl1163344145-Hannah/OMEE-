import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
export class Store {
  constructor(file) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db
      .exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,password TEXT NOT NULL,disabled INTEGER NOT NULL DEFAULT 0,platform_admin INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,type TEXT NOT NULL CHECK(type IN ('personal','enterprise')),owner_id TEXT NOT NULL REFERENCES users(id));
  CREATE TABLE IF NOT EXISTS memberships(workspace_id TEXT REFERENCES workspaces(id),user_id TEXT REFERENCES users(id),role TEXT NOT NULL CHECK(role IN ('owner','admin','designer','viewer','product_manager','finance')),status TEXT NOT NULL CHECK(status IN ('active','revoked')),PRIMARY KEY(workspace_id,user_id));
  CREATE TABLE IF NOT EXISTS invitations(id TEXT PRIMARY KEY,workspace_id TEXT REFERENCES workspaces(id),user_id TEXT REFERENCES users(id),role TEXT NOT NULL,expires INTEGER NOT NULL,status TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS customers(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,UNIQUE(workspace_id,user_id));
  CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),name TEXT NOT NULL,sha256 TEXT NOT NULL,size INTEGER NOT NULL,state TEXT NOT NULL,format TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),UNIQUE(id,workspace_id));
  CREATE TABLE IF NOT EXISTS families(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),name TEXT NOT NULL,UNIQUE(id,workspace_id));
  CREATE TABLE IF NOT EXISTS variants(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL, family_id TEXT NOT NULL,sku TEXT NOT NULL,name TEXT NOT NULL,width_mm INTEGER NOT NULL,depth_mm INTEGER NOT NULL,height_mm INTEGER NOT NULL,asset_id TEXT,UNIQUE(workspace_id,sku),UNIQUE(id,workspace_id),FOREIGN KEY(family_id,workspace_id) REFERENCES families(id,workspace_id),FOREIGN KEY(asset_id,workspace_id) REFERENCES assets(id,workspace_id));
  CREATE TABLE IF NOT EXISTS suppliers(id TEXT PRIMARY KEY,name TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id));
  CREATE TABLE IF NOT EXISTS offers(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,variant_id TEXT NOT NULL,supplier_id TEXT NOT NULL REFERENCES suppliers(id),sale_fen INTEGER NOT NULL CHECK(sale_fen>=0),cost_fen INTEGER NOT NULL CHECK(cost_fen>=0),stock INTEGER NOT NULL CHECK(stock>=0),valid_until INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 1,UNIQUE(id,workspace_id),FOREIGN KEY(variant_id,workspace_id) REFERENCES variants(id,workspace_id));
  CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),customer_id TEXT,designer_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL,scene TEXT NOT NULL,UNIQUE(id,workspace_id),FOREIGN KEY(customer_id) REFERENCES customers(id));
  CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),version INTEGER NOT NULL,scene TEXT NOT NULL,hash TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),UNIQUE(project_id,version));
  CREATE TABLE IF NOT EXISTS submissions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),revision_id TEXT NOT NULL REFERENCES revisions(id),customer_user_id TEXT NOT NULL REFERENCES users(id),payload TEXT NOT NULL,hash TEXT NOT NULL,state TEXT NOT NULL,expires INTEGER NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS approvals(submission_id TEXT REFERENCES submissions(id),kind TEXT CHECK(kind IN ('design','bom')),actor_id TEXT NOT NULL REFERENCES users(id),hash TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(submission_id,kind));
  CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY,submission_id TEXT NOT NULL REFERENCES submissions(id),actor_id TEXT NOT NULL REFERENCES users(id),body TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS choices(submission_id TEXT PRIMARY KEY REFERENCES submissions(id),choice TEXT NOT NULL CHECK(choice IN ('self','platform')),actor_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sales_orders(id TEXT PRIMARY KEY,submission_id TEXT UNIQUE NOT NULL REFERENCES submissions(id),customer_user_id TEXT NOT NULL REFERENCES users(id),amount_fen INTEGER NOT NULL,currency TEXT NOT NULL,status TEXT NOT NULL,lines TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS payment_events(provider TEXT NOT NULL,event_id TEXT NOT NULL,order_id TEXT NOT NULL REFERENCES sales_orders(id),digest TEXT NOT NULL,PRIMARY KEY(provider,event_id));
  CREATE TABLE IF NOT EXISTS purchase_orders(id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES sales_orders(id),supplier_id TEXT NOT NULL REFERENCES suppliers(id),status TEXT NOT NULL,lines TEXT NOT NULL,UNIQUE(order_id,supplier_id));
  CREATE TABLE IF NOT EXISTS service_orders(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),amount_fen INTEGER NOT NULL,status TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,actor_id TEXT,action TEXT NOT NULL,target TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TRIGGER IF NOT EXISTS immutable_submission BEFORE UPDATE OF payload,hash,revision_id,customer_user_id,project_id ON submissions BEGIN SELECT RAISE(ABORT,'immutable submission'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_revision BEFORE UPDATE ON revisions BEGIN SELECT RAISE(ABORT,'immutable revision'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_approval BEFORE UPDATE ON approvals BEGIN SELECT RAISE(ABORT,'immutable approval'); END;
  PRAGMA user_version=1;`);
  }
  get(sql, ...p) {
    return this.db.prepare(sql).get(...p);
  }
  all(sql, ...p) {
    return this.db.prepare(sql).all(...p);
  }
  run(sql, ...p) {
    return this.db.prepare(sql).run(...p);
  }
  tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      if (r?.then) throw Error("Transactions must be synchronous");
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
