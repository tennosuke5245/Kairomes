import path from "node:path";
import { KairomesError } from "@kairomes/protocol";

/** Called by trusted local flows after their destination has been validated. */
export async function openExternal(url: string) {
  const argv =
    process.platform === "win32"
      ? [
          path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "rundll32.exe"),
          "url.dll,FileProtocolHandler",
          url,
        ]
      : process.platform === "darwin"
        ? ["open", url]
        : ["xdg-open", url];
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new KairomesError("OPEN_FAILED", "無法開啟瀏覽器。");
}
