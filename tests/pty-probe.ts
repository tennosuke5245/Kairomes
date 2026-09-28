// Invoked inside the integration-test shell, not by the test runner directly.
if (process.argv[2] === "child") {
  setInterval(() => undefined, 1000);
} else if (process.argv[2] === "spawn-child") {
  const child = Bun.spawn([process.execPath, import.meta.path, "child"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  });
  console.log(`KAIROMES_CHILD_PID:${child.pid}`);
  // Keep the intermediate process alive to verify grandchild cleanup as well.
  setInterval(() => undefined, 1000);
} else {
  console.log(
    `KAIROMES_PROBE:${JSON.stringify({ tty: process.stdout.isTTY, cwd: process.cwd(), secret: process.env.KAIROMES_TEST_SECRET ?? null, unicode: "終端機測試🐈" })}`,
  );
}
