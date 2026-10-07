import { Database } from "bun:sqlite";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { KairomesError, type Workspace } from "@kairomes/protocol";
import { hasControlCharacters, identifyRoot, isWithin, type RootIdentity } from "./paths.ts";

export function defaultDataDirectory(): string {
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"),
      "Kairomes",
    );
  }
  return path.join(
    process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share"),
    "kairomes",
  );
}

type WorkspaceRow = RootIdentity & { id: string; name: string };

function validName(label: string): string {
  const name = label.trim();
  if (!name || name.length > 80 || hasControlCharacters(name)) {
    throw new KairomesError("INVALID_NAME", "工作區名稱須為 1～80 個可見字元。");
  }
  return name;
}

export class WorkspaceRegistry {
  private constructor(
    private readonly db: Database,
    readonly dataDirectory: string,
  ) {}

  static async open(directory: string): Promise<WorkspaceRegistry> {
    await mkdir(path.resolve(directory), { recursive: true, mode: 0o700 });
    const resolved = await realpath(path.resolve(directory));
    const databasePath = path.join(resolved, "state.sqlite");
    try {
      const info = await lstat(databasePath);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) {
        throw new KairomesError("STATE_LINK", "狀態資料庫不能使用連結或特殊檔案。");
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
        throw error;
    }
    const db = new Database(databasePath, { create: true, strict: true });
    try {
      const version =
        db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
      if (version > 1)
        throw new KairomesError(
          "STATE_VERSION",
          "狀態資料庫來自較新的 Kairomes 版本，請升級程式。",
        );
      db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
      if (version === 0) {
        // Bun 1.3.9 transaction() retains internal statements on Windows.
        // Explicit SQL keeps the migration atomic and allows close(true) to release the file.
        db.exec("BEGIN IMMEDIATE");
        try {
          db.exec(`CREATE TABLE IF NOT EXISTS workspaces (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL UNIQUE,
            dev TEXT NOT NULL, ino TEXT NOT NULL
          ); PRAGMA user_version = 1; COMMIT;`);
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }
      return new WorkspaceRegistry(db, resolved);
    } catch (error) {
      db.close(true);
      throw error;
    }
  }

  list(): Workspace[] {
    return this.db
      .query<{ id: string; name: string }, []>("SELECT id, name FROM workspaces ORDER BY name, id")
      .all()
      .map((row) => ({ ...row, capabilities: ["read", "write_request"] }));
  }

  get(id: string): WorkspaceRow {
    const row = this.db
      .query<WorkspaceRow, [string]>("SELECT id, name, root, dev, ino FROM workspaces WHERE id = ?")
      .get(id);
    if (!row) throw new KairomesError("WORKSPACE_NOT_FOUND", "找不到已掛載的工作區。");
    return row;
  }

  async add(input: string, label?: string): Promise<Workspace> {
    const identity = await identifyRoot(input);
    if (
      isWithin(identity.root, this.dataDirectory) ||
      isWithin(this.dataDirectory, identity.root)
    ) {
      throw new KairomesError(
        "STATE_OVERLAP",
        "工作區不能包含 Kairomes 狀態資料夾，請改用其他 --data-dir。",
      );
    }
    const name = validName(label ?? path.basename(identity.root));
    const existing = this.db
      .query<{ id: string }, [string]>("SELECT id FROM workspaces WHERE root = ?")
      .get(identity.root);
    const id = existing?.id ?? crypto.randomUUID();
    this.db
      .query(`INSERT INTO workspaces (id, name, root, dev, ino) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(root) DO UPDATE SET name = excluded.name, dev = excluded.dev, ino = excluded.ino`)
      .run(id, name, identity.root, identity.dev, identity.ino);
    return { id, name, capabilities: ["read", "write_request"] };
  }

  /** Renames a mounted workspace. The name follows the same rules as add(); the root is kept. */
  rename(id: string, label: string): Workspace {
    const name = validName(label);
    if (this.db.query("UPDATE workspaces SET name = ? WHERE id = ?").run(name, id).changes === 0) {
      throw new KairomesError("WORKSPACE_NOT_FOUND", "找不到已掛載的工作區。");
    }
    return { id, name, capabilities: ["read", "write_request"] };
  }

  /**
   * Trusted local Desktop only. This is the one listing that carries absolute roots; it must
   * never feed list(), workspace_list, the widget, Extension streams or any model output.
   */
  details(): { id: string; name: string; root: string }[] {
    return this.db
      .query<{ id: string; name: string; root: string }, []>(
        "SELECT id, name, root FROM workspaces ORDER BY name, id",
      )
      .all()
      .map(({ id, name, root }) => ({ id, name, root }));
  }

  remove(id: string): void {
    if (this.db.query("DELETE FROM workspaces WHERE id = ?").run(id).changes === 0) {
      throw new KairomesError("WORKSPACE_NOT_FOUND", "找不到已掛載的工作區。");
    }
  }

  close(): void {
    this.db.close(true);
  }
}
