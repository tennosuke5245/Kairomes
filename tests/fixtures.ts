import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkspaceRegistry } from "../packages/workspace-core/src/registry.ts";

export async function fixture() {
  const temp = await realpath(tmpdir());
  const directory = await mkdtemp(path.join(temp, "kairomes-test-"));
  const root = path.join(directory, "project");
  const state = path.join(directory, "state");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "README.md"), "# Fixture\nHello Kairomes\n第三行測試\n");
  await writeFile(path.join(root, "src", "main.ts"), 'export const message = "Kairomes";\n');
  const registry = await WorkspaceRegistry.open(state);
  const workspace = await registry.add(root, "測試專案");
  return {
    directory,
    root,
    state,
    registry,
    workspace,
    async dispose() {
      registry.close();
      if (
        path.dirname(directory) !== temp ||
        !path.basename(directory).startsWith("kairomes-test-")
      ) {
        throw new Error("Refusing unsafe fixture cleanup");
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}
