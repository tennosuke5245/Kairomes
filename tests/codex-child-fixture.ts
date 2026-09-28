// Protocol fixture only. Does not log in, generate answers, or run commands.
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const call = JSON.parse(line);
  if (call.id === undefined) return;
  if (call.method === "test/timeout") return;
  if (call.method === "test/exit") process.exit(0);
  if (call.method === "test/reject")
    console.log(
      JSON.stringify({ id: call.id, error: { code: -1, message: "private backend detail" } }),
    );
  else
    console.log(
      JSON.stringify({
        id: call.id,
        result: call.method === "initialize" ? {} : { received: call.params },
      }),
    );
});
