import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { KairomesError, publicError } from "@kairomes/protocol";
import { defaultDataDirectory } from "@kairomes/workspace-core";
import { runCompanion } from "./companion.ts";

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "data-dir": { type: "string" },
      "control-port": { type: "string" },
      "no-open": { type: "boolean" },
      "no-tunnel": { type: "boolean" },
    },
  });
  const dataDirectory = path.resolve(values["data-dir"] ?? defaultDataDirectory());
  const port = Number(values["control-port"] ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new KairomesError("USAGE", "Companion 控制連接埠須為 0～65535 的整數。");
  await runCompanion({
    dataDirectory,
    port,
    openBrowser: !values["no-open"],
    autoStartTunnel: !values["no-tunnel"],
  });
}

main().catch(async (error: unknown) => {
  const safe = publicError(error);
  const directory = defaultDataDirectory();
  const log = path.join(directory, "companion-startup-error.txt");
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(
      log,
      `Kairomes Companion 無法啟動\r\n\r\n${safe.code}: ${safe.message}\r\n`,
      "utf8",
    );
    if (process.platform === "win32")
      Bun.spawn(["notepad.exe", log], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  } catch {
    console.error(`${safe.code}: ${safe.message}`);
  }
  process.exitCode = 1;
});
