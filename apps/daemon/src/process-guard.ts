import path from "node:path";
import { KairomesError } from "@kairomes/protocol";

// Windows Job Objects are lifecycle management, not a filesystem/network sandbox.
// Load FFI only on Windows; no compiler or native npm package is required.
export async function createProcessGuard(): Promise<{ attach(pid: number): void; close(): void }> {
  if (process.platform !== "win32") {
    let group: number | undefined;
    return {
      attach(pid) {
        group = pid;
      },
      close() {
        if (group === undefined) return;
        const pid = group;
        group = undefined;
        try {
          process.kill(-pid, "SIGKILL");
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH"))
            throw error;
        }
      },
    };
  }
  if (process.arch !== "x64" && process.arch !== "arm64")
    throw new KairomesError("PROCESS_GUARD", "目前 Windows 終端機需要 64 位元執行環境。");
  const { dlopen } = await import("bun:ffi");
  const lib = dlopen(
    path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "kernel32.dll"),
    {
      CreateJobObjectW: { args: ["ptr", "ptr"], returns: "ptr" },
      SetInformationJobObject: { args: ["ptr", "i32", "buffer", "u32"], returns: "i32" },
      OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
      AssignProcessToJobObject: { args: ["ptr", "ptr"], returns: "i32" },
      CloseHandle: { args: ["ptr"], returns: "i32" },
    },
  );
  const api = lib.symbols;
  const job = api.CreateJobObjectW(null, null);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (job) api.CloseHandle(job);
    lib.close();
  };
  // Win64 JOBOBJECT_EXTENDED_LIMIT_INFORMATION: 144 bytes; LimitFlags offset 16.
  const limits = Buffer.alloc(144);
  limits.writeUInt32LE(0x2000, 16); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  if (!job || !api.SetInformationJobObject(job, 9, limits, limits.length)) {
    close();
    throw new KairomesError("PROCESS_GUARD", "無法建立 Windows 程序群組；終端機未啟動。");
  }
  return {
    attach(pid) {
      const processHandle = api.OpenProcess(0x0101, 0, pid); // SET_QUOTA | TERMINATE
      try {
        if (!processHandle || !api.AssignProcessToJobObject(job, processHandle))
          throw new KairomesError("PROCESS_GUARD", "無法將 shell 加入 Windows 程序群組。");
      } finally {
        if (processHandle) api.CloseHandle(processHandle);
      }
    },
    close,
  };
}
