// The helper starts in Kairomes' private state directory. It cannot launch the
// requested program until the parent attaches it to the process group and sends IPC.
// Target stdio is separate from this private IPC channel, so output cannot spoof exits.
export const commandRunner = `
let used = false;
process.on("message", async (input) => {
  if (used) return;
  used = true;
  try {
    const child = Bun.spawn(input.argv, { cwd: input.cwd, env: input.env,
      stdin: "ignore", stdout: "inherit", stderr: "inherit", windowsHide: true });
    process.send({type:"started"});
    const code = await child.exited;
    process.send({type:"result", code, signal:child.signalCode ?? null});
  } catch {
    process.send({type:"launch-error"});
  }
});
process.send({type:"ready"});
`;
