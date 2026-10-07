import { expect, test } from "bun:test";
import {
  MCP_COMMAND_RELATIVE_MESSAGE,
  MCP_CWD_INVALID_MESSAGE,
  type McpCatalogTool,
  type McpPanelState,
} from "@kairomes/protocol";
import {
  McpMutationTracker,
  mcpAddFingerprint,
  mcpCwdRefusal,
  mcpMutationObserved,
  readMcpMutationState,
  settleMcpMutation,
} from "./mcp-mutation.ts";

test("a committed add with a lost response is read back without adding twice", async () => {
  const requests: unknown[] = [];
  const state = { servers: [] as string[] };
  let paused = false;
  const result = await settleMcpMutation(
    async (body) => {
      requests.push(body);
      if ((body as { action: string }).action === "add_stdio") {
        state.servers.push("new-server");
        throw new Error("Response lost after commit");
      }
      expect(paused).toBe(true);
      return structuredClone(state);
    },
    { action: "add_stdio", name: "Browser" },
    () => {
      paused = true;
    },
    (state) => state.servers.includes("new-server"),
  );
  expect(requests).toEqual([{ action: "add_stdio", name: "Browser" }, { action: "list" }]);
  expect(result).toEqual({ outcome: "reconciled", state: { servers: ["new-server"] } });
});

test("an unreachable state stays unknown and never claims the old catalog is current", async () => {
  const requests: unknown[] = [];
  const result = await settleMcpMutation(
    async (body) => {
      requests.push(body);
      throw new Error("Offline");
    },
    { action: "remove", server_id: "one" },
    () => {},
    () => false,
  );
  expect(result).toEqual({ outcome: "unknown" });
  expect(requests).toEqual([{ action: "remove", server_id: "one" }, { action: "list" }]);
});

test("a successful mutation does not perform a second request", async () => {
  const requests: unknown[] = [];
  const result = await settleMcpMutation(
    async (body) => {
      requests.push(body);
      return "current";
    },
    { action: "set_tool_enabled", enabled: false },
    () => {
      throw new Error("Successful response should not pause");
    },
    () => false,
  );
  expect(result).toEqual({ outcome: "applied", state: "current" });
  expect(requests).toHaveLength(1);
});

test("only a recognized refusal skips reconciliation; other failures still read back", async () => {
  const refusal = Object.assign(new Error("請求未被接受。"), { code: "MCP_CWD_INVALID" });
  const rejected = (error: unknown) => mcpCwdRefusal(error) !== undefined;
  // The field shows the panel's own sentence for the code, never the response's text.
  expect(mcpCwdRefusal(refusal)).toBe(MCP_CWD_INVALID_MESSAGE);
  expect(mcpCwdRefusal({ code: "MCP_COMMAND_RELATIVE", message: "/private/x" })).toBe(
    MCP_COMMAND_RELATIVE_MESSAGE,
  );
  for (const other of [
    new Error("Offline"),
    { code: "VALIDATION" },
    { code: "toString" },
    { code: "__proto__" },
    undefined,
    "MCP_CWD_INVALID",
  ])
    expect(mcpCwdRefusal(other)).toBeUndefined();
  const requests: unknown[] = [];
  let paused = false;
  const body = { action: "add_stdio", name: "相對路徑", command: "npx", cwd: "/srv/work" };
  const refused = await settleMcpMutation(
    async (request) => {
      requests.push(request);
      throw refusal;
    },
    body,
    () => {
      paused = true;
    },
    () => false,
    () => true,
    rejected,
  );
  expect(refused).toEqual({ outcome: "rejected", error: refusal });
  expect({ requests, paused }).toEqual({ requests: [body], paused: false });
  const lost = await settleMcpMutation(
    async (request) => {
      requests.push(request);
      throw new Error("Response lost");
    },
    body,
    () => {
      paused = true;
    },
    () => false,
    () => true,
    rejected,
  );
  expect(lost).toEqual({ outcome: "unknown" });
  expect(paused).toBe(true);
  expect(requests).toEqual([body, body, { action: "list" }]);
});

test("a relative working directory has no launch identity, so it is never sent", async () => {
  const stdio = { action: "add_stdio", name: "服務", command: "npx", args: [], env: [] };
  for (const cwd of ["project", "./project", "~/project", "C:project"])
    expect(await mcpAddFingerprint({ ...stdio, cwd })).toBeUndefined();
  for (const cwd of ["C:\\work", "/srv/work", "\\\\server\\share"])
    expect(await mcpAddFingerprint({ ...stdio, cwd })).toMatch(/^[a-f0-9]{64}$/);
  // Nor does a relative command path without a working directory.
  expect(await mcpAddFingerprint({ ...stdio, command: "./start-mcp.sh" })).toBeUndefined();
  expect(
    await mcpAddFingerprint({ ...stdio, command: "./start-mcp.sh", cwd: "/srv/work" }),
  ).toMatch(/^[a-f0-9]{64}$/);
});

const tool: McpCatalogTool = {
  ref: "ref-one",
  server_id: "server-one",
  server_name: "測試",
  name: "read",
  enabled: true,
  availability: "ready",
  schema_fingerprint: "schema-one",
  read_only_hint: true,
  destructive_hint: false,
  open_world_hint: false,
};
const base = (): McpPanelState => ({
  catalog_revision: "base",
  servers: [
    {
      id: "server-one",
      name: "測試",
      transport: "stdio",
      config_fingerprint: "1".repeat(64),
      enabled: true,
      state: "ready",
      tools: [structuredClone(tool)],
    },
  ],
});
const newServer = (): McpPanelState["servers"][number] => ({
  id: "server-new",
  name: "新服務",
  transport: "http",
  config_fingerprint: "2".repeat(64),
  enabled: true,
  state: "connecting",
  tools: [],
});
const added = (): McpPanelState => ({
  catalog_revision: "next",
  servers: [...base().servers, newServer()],
});

test("successful list with unchanged or unrelated catalog never settles an in-flight add", async () => {
  const tracker = new McpMutationTracker();
  const body = { action: "add_http", name: "新服務", url: "https://example.test/mcp" };
  tracker.begin(base(), body, undefined, "2".repeat(64));
  const requests: unknown[] = [];
  const result = await settleMcpMutation(
    async (request) => {
      requests.push(request);
      if ((request as { action: string }).action !== "list") throw new Error("Still committing");
      return base();
    },
    body,
    () => {},
    (state) => tracker.observe(state),
  );
  expect(result).toEqual({ outcome: "unknown", state: base() });
  expect(tracker.locked).toBe(true);
  expect(tracker.observe({ ...base(), catalog_revision: "unrelated" })).toBe(false);
  // Closing a view and attempting to reopen/re-submit cannot start a second mutation.
  expect(tracker.begin(base(), body)).toBe(false);
  expect(requests).toEqual([body, { action: "list" }]);
  expect(tracker.observe(added())).toBe(true);
  expect(tracker.locked).toBe(false);
});

test("add needs a unique new ID and matching transport/name; old or ambiguous names are insufficient", () => {
  const body = { action: "add_http", name: "新服務" };
  expect(mcpMutationObserved(base(), added(), body, "2".repeat(64))).toBe(true);
  for (const candidate of [
    { ...added(), catalog_revision: "base" },
    { ...added(), servers: [{ ...newServer(), id: "server-one" }] },
    { ...added(), servers: [{ ...newServer(), transport: "stdio" as const }] },
    { ...added(), servers: [{ ...newServer(), name: "別的服務" }] },
    { ...added(), servers: [{ ...newServer(), enabled: false }] },
    { ...added(), servers: [{ ...newServer(), config_fingerprint: undefined }] },
    { ...added(), servers: [{ ...newServer(), config_fingerprint: "3".repeat(64) }] },
    { ...added(), servers: [...added().servers, { ...newServer(), id: "server-second" }] },
  ])
    expect(mcpMutationObserved(base(), candidate, body, "2".repeat(64))).toBe(false);
});

test("a persisted unavailable server with no tools settles only its exact add configuration", async () => {
  const body = {
    action: "add_http",
    name: "新服務",
    url: "https://example.test/unavailable",
    header_env: {},
  };
  const fingerprint = await mcpAddFingerprint(body);
  if (!fingerprint) throw new Error("Missing fixture identity");
  const next: McpPanelState = {
    catalog_revision: "saved-but-unavailable",
    servers: [
      ...base().servers,
      {
        ...newServer(),
        config_fingerprint: fingerprint,
        state: "unavailable",
        tools: [],
      },
    ],
  };
  const tracker = new McpMutationTracker();
  tracker.bind("same-instance");
  tracker.begin(base(), body, "same-instance", fingerprint);
  const requests: unknown[] = [];
  const result = await settleMcpMutation(
    async (request) => {
      requests.push(request);
      if ((request as { action: string }).action !== "list")
        throw new Error("Connection failed after saving the server");
      return structuredClone(next);
    },
    body,
    () => {},
    (state) => tracker.observe(state, "same-instance"),
  );
  expect(result).toEqual({ outcome: "reconciled", state: next });
  expect(requests).toEqual([body, { action: "list" }]);
  expect(tracker.locked).toBe(false);

  for (const observedFingerprint of [undefined, "3".repeat(64)]) {
    const pending = new McpMutationTracker();
    pending.bind("same-instance");
    pending.begin(base(), body, "same-instance", fingerprint);
    const unconfirmed = structuredClone(next);
    const server = unconfirmed.servers.find((item) => item.id === "server-new");
    if (!server) throw new Error("Missing fixture server");
    server.config_fingerprint = observedFingerprint;
    expect(pending.observe(unconfirmed, "same-instance")).toBe(false);
    expect(pending.locked).toBe(true);
    expect(pending.begin(unconfirmed, body, "same-instance", fingerprint)).toBe(false);
    expect(pending.observe(next, "same-instance")).toBe(true);
    expect(pending.locked).toBe(false);
  }
});

test("missing add fingerprints diagnose only a unique matching server from the same source", async () => {
  const body = { action: "add_http", name: "新服務", url: "https://example.test/mcp" };
  const fingerprint = await mcpAddFingerprint(body);
  if (!fingerprint) throw new Error("Missing fixture identity");
  const tracker = new McpMutationTracker();
  tracker.bind("original-instance");
  tracker.begin(base(), body, "original-instance", fingerprint);
  const missing = added();
  const server = missing.servers.find((item) => item.id === "server-new");
  if (!server) throw new Error("Missing fixture server");
  server.config_fingerprint = undefined;
  server.state = "unavailable";
  expect(tracker.diagnostic(missing, "different-instance")).toBeUndefined();
  expect(tracker.diagnostic(missing, "original-instance")).toBe("missing_fingerprint");
  expect(tracker.observe(missing, "original-instance")).toBe(false);
  expect(tracker.locked).toBe(true);
  expect(tracker.begin(base(), body, "original-instance", fingerprint)).toBe(false);
  for (const candidate of [
    { ...missing, catalog_revision: "base" },
    { ...missing, servers: [{ ...server, id: "server-one" }] },
    { ...missing, servers: [{ ...server, transport: "stdio" as const }] },
    { ...missing, servers: [{ ...server, name: "別的服務" }] },
    { ...missing, servers: [{ ...server, enabled: false }] },
    { ...missing, servers: [...missing.servers, { ...server, id: "another-new-server" }] },
    { ...missing, servers: [{ ...server, config_fingerprint: "3".repeat(64) }] },
    { ...missing, servers: [{ ...server, config_fingerprint: fingerprint }] },
  ])
    expect(tracker.diagnostic(candidate, "original-instance")).toBeUndefined();
  expect(tracker.diagnostic(undefined, "original-instance")).toBeUndefined();
  expect(tracker.locked).toBe(true);
  server.config_fingerprint = fingerprint;
  expect(tracker.observe(missing, "original-instance")).toBe(true);
  expect(tracker.diagnostic(missing, "original-instance")).toBeUndefined();
  expect(tracker.locked).toBe(false);

  const remove = new McpMutationTracker();
  remove.bind("original-instance");
  remove.begin(base(), { action: "remove", server_id: "server-one" }, "original-instance");
  expect(remove.diagnostic(missing, "original-instance")).toBeUndefined();
});

test("toggle/remove evidence stays tied to the original server and tool schema", () => {
  const next = base();
  next.catalog_revision = "changed";
  const server = next.servers[0];
  const currentTool = server?.tools[0];
  if (!server || !currentTool) throw new Error("Missing fixture server/tool");
  server.enabled = false;
  expect(
    mcpMutationObserved(base(), next, {
      action: "set_server_enabled",
      server_id: "server-one",
      enabled: false,
    }),
  ).toBe(true);
  expect(
    mcpMutationObserved(base(), next, {
      action: "set_server_enabled",
      server_id: "other",
      enabled: false,
    }),
  ).toBe(false);
  currentTool.enabled = false;
  const disableTool = {
    action: "set_tool_enabled",
    server_id: "server-one",
    tool_name: "read",
    enabled: false,
  };
  expect(mcpMutationObserved(base(), next, disableTool)).toBe(true);
  currentTool.schema_fingerprint = "new-schema";
  expect(mcpMutationObserved(base(), next, disableTool)).toBe(false);
  expect(
    mcpMutationObserved(
      base(),
      { catalog_revision: "gone", servers: [] },
      { action: "remove", server_id: "server-one" },
    ),
  ).toBe(true);
  expect(mcpMutationObserved(base(), next, { action: "remove", server_id: "server-one" })).toBe(
    false,
  );
  expect(mcpMutationObserved(base(), next, { action: "refresh", server_id: "server-one" })).toBe(
    false,
  );
});

test("a replacement daemon and edited form cannot provide evidence for the original mutation", () => {
  const tracker = new McpMutationTracker();
  tracker.bind("original-instance");
  const initial = base();
  const body = { action: "add_http", name: "新服務" };
  tracker.begin(initial, body, "original-instance", "2".repeat(64));
  body.name = "編輯後的表單";
  initial.servers.push(newServer());
  expect(tracker.observe(added(), "different-instance")).toBe(false);
  expect(tracker.locked).toBe(true);
  expect(tracker.observe(added(), "original-instance")).toBe(true);
});

test("a same-name new server with a different launch body cannot settle the original add", async () => {
  const body = {
    action: "add_http",
    name: "新服務",
    url: "https://example.test/original",
    header_env: { Authorization: "ORIGINAL_KEY" },
  };
  const original = await mcpAddFingerprint(body);
  const different = await mcpAddFingerprint({ ...body, url: "https://example.test/different" });
  const next = added();
  const server = next.servers.find((item) => item.id === "server-new");
  if (!server) throw new Error("Missing fixture server");
  server.config_fingerprint = different;
  const tracker = new McpMutationTracker();
  tracker.bind("same-instance");
  tracker.begin(base(), body, "same-instance", original);
  expect(tracker.observe(next, "same-instance")).toBe(false);
  expect(tracker.locked).toBe(true);
  server.config_fingerprint = original;
  expect(tracker.observe(next, "same-instance")).toBe(true);
  for (const change of [
    { command: "other-program" },
    { args: ["other-argument"] },
    { cwd: "/srv/other-directory" },
    { env: ["OTHER_KEY"] },
  ]) {
    const stdio = {
      action: "add_stdio",
      name: "同名服務",
      command: "program",
      args: ["argument"],
      cwd: "/srv/directory",
      env: ["ORIGINAL_KEY"],
    };
    expect(await mcpAddFingerprint({ ...stdio, ...change })).not.toBe(
      await mcpAddFingerprint(stdio),
    );
  }
});

test("invalid add inputs have no launch identity and cannot be used as mutation evidence", async () => {
  expect(
    await mcpAddFingerprint({ action: "add_http", name: "測試", url: "invalid" }),
  ).toBeUndefined();
  expect(
    await mcpAddFingerprint({
      action: "add_stdio",
      name: "測試",
      command: "program",
      args: Array(65).fill("argument"),
    }),
  ).toBeUndefined();
  expect(mcpMutationObserved(base(), added(), { action: "add_http", name: "新服務" })).toBe(false);
});

test("unknown mutations stay with each source when leaving and returning", () => {
  const tracker = new McpMutationTracker();
  const body = { action: "add_http", name: "新服務" };
  tracker.bind("source-a");
  expect(tracker.begin(base(), body, "source-a", "2".repeat(64))).toBe(true);
  tracker.bind("source-b");
  expect(tracker.locked).toBe(false);
  expect(tracker.isLocked("source-a")).toBe(true);
  expect(tracker.isLocked(undefined)).toBe(false);
  expect(tracker.observe(added(), "source-a")).toBe(false);
  expect(tracker.begin(base(), { action: "remove", server_id: "server-one" }, "source-b")).toBe(
    true,
  );
  expect(tracker.observe(added(), "source-b")).toBe(false);
  tracker.bind("source-a");
  expect(tracker.locked).toBe(true);
  expect(tracker.begin(base(), body, "source-a", "2".repeat(64))).toBe(false);
  expect(tracker.observe(added(), "source-a")).toBe(true);
  expect(tracker.locked).toBe(false);
  tracker.bind("source-b");
  expect(tracker.locked).toBe(true);
  expect(tracker.observe({ catalog_revision: "removed", servers: [] }, "source-b")).toBe(true);
  expect(tracker.locked).toBe(false);
});

test("a lost old-source response does not query the new source or change its UI", async () => {
  const tracker = new McpMutationTracker();
  tracker.bind("source-a");
  const body = { action: "refresh", server_id: "server-one" };
  tracker.begin(base(), body, "source-a");
  const scope = tracker.capture();
  const calls: unknown[] = [];
  const reports: string[] = [];
  let rejectMutation: (cause: Error) => void = () => {};
  const pending = new Promise<McpPanelState>((_, reject) => {
    rejectMutation = reject;
  });
  const result = settleMcpMutation(
    async (request) => {
      calls.push(request);
      return request === body ? pending : added();
    },
    body,
    () => reports.push("unknown"),
    (state) => tracker.observe(state, "source-b"),
    () => tracker.isCurrent(scope),
  );
  tracker.bind("source-b");
  rejectMutation(new Error("Old connection replaced"));
  expect(await result).toEqual({ outcome: "unknown" });
  expect(calls).toEqual([body]);
  expect(reports).toEqual([]);
  expect(tracker.locked).toBe(false);
  tracker.bind("source-a");
  expect(tracker.locked).toBe(true);
  expect(tracker.begin(base(), body, "source-a")).toBe(false);
});

test("a successful response after leaving and returning cannot overwrite a new view", async () => {
  const tracker = new McpMutationTracker();
  tracker.bind("source-a");
  const body = { action: "add_http", name: "新服務" };
  tracker.begin(base(), body, "source-a", "2".repeat(64));
  const scope = tracker.capture();
  let complete: (state: McpPanelState) => void = () => {};
  const pending = new Promise<McpPanelState>((resolve) => {
    complete = resolve;
  });
  const result = settleMcpMutation(
    () => pending,
    body,
    () => {},
    (state) => tracker.observe(state, "source-a"),
    () => tracker.isCurrent(scope),
  );
  tracker.bind("source-b");
  tracker.bind("source-a");
  complete(added());
  expect(await result).toEqual({ outcome: "unknown" });
  expect(tracker.locked).toBe(true);
  expect(tracker.observe(added(), "source-a")).toBe(true);
});

test("an automatic reconciliation list cannot settle a mutation after switching sources", async () => {
  const tracker = new McpMutationTracker();
  tracker.bind("source-a");
  const body = { action: "add_http", name: "新服務" };
  tracker.begin(base(), body, "source-a", "2".repeat(64));
  const scope = tracker.capture();
  let complete: (state: McpPanelState) => void = () => {};
  const list = new Promise<McpPanelState>((resolve) => {
    complete = resolve;
  });
  let beginRead = () => {};
  const reading = new Promise<void>((resolve) => {
    beginRead = resolve;
  });
  const calls: unknown[] = [];
  let observations = 0;
  const result = settleMcpMutation(
    async (request) => {
      calls.push(request);
      if (request === body) throw new Error("Committed response lost");
      beginRead();
      return list;
    },
    body,
    () => {},
    (state) => {
      observations++;
      return tracker.observe(state, "source-a");
    },
    () => tracker.isCurrent(scope),
  );
  await reading;
  tracker.bind("source-b");
  tracker.begin(base(), { action: "refresh", server_id: "server-one" }, "source-b");
  complete(added());
  expect(await result).toEqual({ outcome: "unknown" });
  expect(calls).toEqual([body, { action: "list" }]);
  expect(observations).toBe(0);
  expect(tracker.isLocked("source-a")).toBe(true);
  expect(tracker.isLocked("source-b")).toBe(true);
});

test("a late reconciliation list cannot clear another source's lock or replace its catalog", async () => {
  const tracker = new McpMutationTracker();
  tracker.bind("source-a");
  tracker.begin(base(), { action: "add_http", name: "新服務" }, "source-a", "2".repeat(64));
  const scope = tracker.capture();
  let complete: (state: McpPanelState) => void = () => {};
  const pending = new Promise<McpPanelState>((resolve) => {
    complete = resolve;
  });
  const read = readMcpMutationState(
    () => pending,
    () => tracker.isCurrent(scope),
  );
  tracker.bind("source-b");
  tracker.begin(base(), { action: "refresh", server_id: "server-one" }, "source-b");
  complete(added());
  expect(await read).toBeUndefined();
  expect(tracker.locked).toBe(true);
  expect(tracker.isLocked("source-a")).toBe(true);
  tracker.bind("source-a");
  expect(tracker.isCurrent(scope)).toBe(false);
  expect(tracker.locked).toBe(true);
  let calls = 0;
  expect(
    await readMcpMutationState(
      async () => {
        calls++;
        return added();
      },
      () => tracker.isCurrent(scope),
    ),
  ).toBeUndefined();
  expect(calls).toBe(0);
  const fresh = tracker.capture();
  const current = await readMcpMutationState(
    () => Promise.resolve(added()),
    () => tracker.isCurrent(fresh),
  );
  expect(current?.state).toEqual(added());
  expect(current && tracker.observe(current.state, fresh.source)).toBe(true);
  expect(tracker.isLocked("source-b")).toBe(true);
});
