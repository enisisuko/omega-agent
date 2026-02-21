// Node.js 24+ 内置 SQLite，无需额外依赖
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — node:sqlite 在 Node 24 可用，TypeScript types 尚未同步
import { DatabaseSync } from "node:sqlite";
import path from "path";
import fs from "fs";
import { ALL_CREATE_STATEMENTS, CREATE_INDEXES } from "./schema.js";

/**
 * ICEE 数据库连接管理器
 * 使用 Node.js 24 内置 SQLite (node:sqlite)，零额外依赖
 */
export class IceeDatabase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;

  constructor(dbPath: string) {
    // 确保目录存在
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 初始化内置 SQLite
    this.db = new DatabaseSync(dbPath);

    // 启用 WAL 模式和外键
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA cache_size = -8000");

    // 建表
    this.initialize();
  }

  /** 初始化数据库结构 */
  private initialize(): void {
    for (const statement of ALL_CREATE_STATEMENTS) {
      this.db.exec(statement);
    }
    this.db.exec(CREATE_INDEXES);

    // 写入初始版本记录
    const versionCheck = this.db.prepare(
      "SELECT COUNT(*) as count FROM schema_versions WHERE version = ?"
    ).get("0.1.0") as { count: number };

    if (versionCheck.count === 0) {
      this.db.prepare(
        "INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)"
      ).run("0.1.0", new Date().toISOString(), "Initial ICEE schema");
    }

    // 迁移：为已有数据库补充 providers 表缺少的列（ALTER TABLE 在列已存在时会抛错，静默忽略即可）
    this.migrateProviders();

    console.log("[IceeDatabase] Database initialized successfully");
  }

  /**
   * providers 表列迁移 (v0.1.1)
   * 早期 schema 缺少 api_key 和 model 列，补充后 save-provider handler 才能正常工作
   * ALTER TABLE ADD COLUMN 在列已存在时会抛 "duplicate column name" 错误，catch 区分处理
   */
  private migrateProviders(): void {
    const migrations = [
      { col: "api_key", sql: "ALTER TABLE providers ADD COLUMN api_key TEXT" },
      { col: "model",   sql: "ALTER TABLE providers ADD COLUMN model TEXT" },
    ];
    for (const m of migrations) {
      try {
        this.db.exec(m.sql);
        console.log(`[IceeDatabase] Migration applied: providers.${m.col} column added`);
      } catch (e) {
        const msg = (e as Error).message ?? "";
        if (msg.includes("duplicate column")) {
          // 列已存在，正常情况，静默跳过（不记录 warn，避免日志噪音）
          console.log(`[IceeDatabase] Migration skipped (already exists): providers.${m.col}`);
        } else {
          // 真正的迁移失败（磁盘满、权限问题等），记录完整错误
          console.error(`[IceeDatabase] Migration FAILED for providers.${m.col}:`, e);
        }
      }
    }
  }

  /** 获取原始 db 实例 (供 Repository 使用) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get instance(): any {
    return this.db;
  }

  /** 关闭数据库 */
  close(): void {
    this.db.close();
    console.log("[IceeDatabase] Database connection closed");
  }

  /** 获取当前 schema 版本 */
  getSchemaVersion(): string {
    const row = this.db.prepare(
      "SELECT version FROM schema_versions ORDER BY id DESC LIMIT 1"
    ).get() as { version: string } | undefined;
    return row?.version ?? "unknown";
  }

  /**
   * 在事务中执行多条操作
   * Node 内置 SQLite 暂不支持 transaction() 包装，使用 BEGIN/COMMIT 代替
   */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

/** 单例数据库实例管理 */
let _dbInstance: IceeDatabase | null = null;

export function getDatabase(dbPath?: string): IceeDatabase {
  if (!_dbInstance) {
    if (!dbPath) {
      throw new Error("Database path is required for first initialization");
    }
    _dbInstance = new IceeDatabase(dbPath);
  }
  return _dbInstance;
}

export function closeDatabase(): void {
  if (_dbInstance) {
    _dbInstance.close();
    _dbInstance = null;
  }
}
