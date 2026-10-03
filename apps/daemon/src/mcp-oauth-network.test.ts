import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import * as https from "node:https";
import { Readable } from "node:stream";
import type { DetailedPeerCertificate } from "node:tls";
import { gzipSync } from "node:zlib";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  createMcpOAuthNetwork,
  createMcpOAuthPinnedLookup,
  isPublicMcpOAuthAddress,
  MCP_OAUTH_NETWORK_LIMITS,
  McpOAuthNetworkError,
  type McpOAuthPinnedRequest,
} from "./mcp-oauth-network.ts";

const endpoint = "https://mcp.example.com/mcp";
const tokenUrl = "https://auth.example.com/token";
const publicAddress = { address: "8.8.8.8", family: 4 as const };
const resolvePublic = async () => [{ ...publicAddress }];
const encoder = new TextEncoder();
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
function jsonRpc(method = "tools/call") {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { name: "synthetic" } });
}
function fakeNetwork(requester: (request: McpOAuthPinnedRequest) => Promise<Response>) {
  return createMcpOAuthNetwork(endpoint, { resolver: resolvePublic, requester });
}

test("public address policy rejects IANA special-purpose and transition blocks with boundary coverage", () => {
  for (const address of [
    "0.0.0.0",
    "0.255.255.255",
    "10.0.0.1",
    "100.64.0.0",
    "100.127.255.255",
    "127.0.0.1",
    "127.255.255.255",
    "169.254.0.1",
    "172.16.0.0",
    "172.31.255.255",
    "192.0.0.9",
    "192.0.2.1",
    "192.88.99.2",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "64:ff9b:1::1",
    "100::1",
    "2001::1",
    "2001:1ff::1",
    "2001:db8::1",
    "2002:0808:0808::1",
    "3ffe::1",
    "3fff::1",
    "3fff:fff::1",
    "5f00::1",
    "fc00::1",
    "fdff::1",
    "fe80::1",
    "ff02::1",
    "8.8.8.8%scope",
    "2001:4860::1%scope",
    "not-an-address",
  ])
    expect(isPublicMcpOAuthAddress(address)).toBe(false);
  for (const address of [
    "1.1.1.1",
    "8.8.8.8",
    "100.63.255.255",
    "100.128.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "198.17.255.255",
    "198.20.0.0",
    "223.255.255.255",
    "2001:200::1",
    "2001:4860:4860::8888",
    "2606:4700:4700::1111",
    "3fff:1000::1",
  ])
    expect(isPublicMcpOAuthAddress(address)).toBe(true);
});

test("URL normalization blocks alternate loopback spelling, special hostnames and URL credentials before dispatch", async () => {
  let calls = 0;
  const network = fakeNetwork(async () => {
    calls++;
    return new Response("{}");
  });
  for (const url of [
    "http://auth.example.com/token",
    "https://user:synthetic-secret@auth.example.com/token",
    "https://auth.example.com/token#",
    "https://auth.example.com/token#fragment",
    "https://127.1/token",
    "https://2130706433/token",
    "https://0x7f000001/token",
    "https://0177.0.0.1/token",
    "https://%31%32%37.0.0.1/token",
    "https://[::1]/token",
    "https://[::ffff:127.0.0.1]/token",
    "https://localhost./token",
    "https://service.local/token",
    "https://service.home.arpa/token",
    "https://service.internal/token",
    "https://service.test/token",
    "https://singlelabel/token",
    "not a URL",
  ])
    await expect(network.oauthFetch(url)).rejects.toBeInstanceOf(McpOAuthNetworkError);
  expect(calls).toBe(0);
});

test("all DNS answers are checked and malformed, private or excessive answers cannot reach a requester", async () => {
  let calls = 0;
  for (const answers of [
    [],
    [{ address: "127.0.0.1", family: 4 as const }],
    [publicAddress, { address: "192.168.0.1", family: 4 as const }],
    [{ address: "8.8.8.8", family: 6 as const }],
    [{ address: "fd00::1", family: 6 as const }],
    Array(33).fill(publicAddress),
  ]) {
    const network = createMcpOAuthNetwork(endpoint, {
      resolver: async () => answers,
      requester: async () => {
        calls++;
        return new Response("{}");
      },
    });
    await expect(network.oauthFetch(tokenUrl)).rejects.toMatchObject({
      code: "MCP_OAUTH_DNS_BLOCKED",
    });
  }
  expect(calls).toBe(0);
});

test("one validated DNS snapshot is pinned per request and a later private rebinding fails before dispatch", async () => {
  let resolutions = 0;
  const pinned: string[] = [];
  const network = createMcpOAuthNetwork(endpoint, {
    resolver: async () =>
      ++resolutions === 1 ? [publicAddress] : [{ address: "10.0.0.1", family: 4 }],
    requester: async (request) => {
      pinned.push(request.address.address);
      return new Response("{}");
    },
  });
  await network.oauthFetch(tokenUrl);
  await expect(network.oauthFetch(tokenUrl)).rejects.toMatchObject({
    code: "MCP_OAUTH_DNS_BLOCKED",
  });
  expect(resolutions).toBe(2);
  expect(pinned).toEqual(["8.8.8.8"]);
});

test("production requester connects to the checked IP and verifies TLS against the original hostname", async () => {
  const originalRequest = https.request;
  const options: https.RequestOptions[] = [];
  const requestMock = spyOn(https, "request").mockImplementation(((
    input: https.RequestOptions,
    receive: (incoming: IncomingMessage) => void,
  ) => {
    options.push(input);
    const request = new EventEmitter() as ClientRequest;
    request.end = (() => {
      const incoming = Readable.from([Buffer.from("{}")]) as IncomingMessage;
      Object.assign(incoming, {
        statusCode: 200,
        rawHeaders: ["content-type", "application/json"],
      });
      incoming.once("close", () => request.emit("close"));
      queueMicrotask(() => receive(incoming));
      return request;
    }) as ClientRequest["end"];
    request.destroy = ((error?: Error) => {
      if (error) request.emit("error", error);
      request.emit("close");
      return request;
    }) as ClientRequest["destroy"];
    return request;
  }) as typeof https.request);
  try {
    const network = createMcpOAuthNetwork(endpoint, { resolver: resolvePublic });
    expect(
      await (await network.oauthFetch("https://auth.example.com:8443/token?synthetic=1")).text(),
    ).toBe("{}");
    const request = options[0];
    expect(request).toMatchObject({
      hostname: "8.8.8.8",
      family: 4,
      port: 8443,
      path: "/token?synthetic=1",
      servername: "auth.example.com",
      rejectUnauthorized: true,
      agent: false,
      headers: { host: "auth.example.com:8443" },
    });
    const certificate = {
      subjectaltname: "DNS:auth.example.com",
      subject: { CN: "auth.example.com" },
    } as DetailedPeerCertificate;
    expect(request?.checkServerIdentity?.("8.8.8.8", certificate)).toBeUndefined();
    expect(
      request?.checkServerIdentity?.("auth.example.com", {
        ...certificate,
        subject: { CN: "8.8.8.8" },
        subjectaltname: "IP Address:8.8.8.8",
      }),
    ).toBeInstanceOf(Error);
    expect(
      request?.checkServerIdentity?.("auth.example.com", {
        ...certificate,
        subjectaltname: "DNS:other.example.com",
      }),
    ).toBeInstanceOf(Error);
    const answers: unknown[][] = [];
    const pinned = createMcpOAuthPinnedLookup(publicAddress);
    pinned("do-not-resolve.example.com", {}, (...values) => answers.push(values));
    pinned("do-not-resolve.example.com", { all: true }, (...values) => answers.push(values));
    expect(answers).toEqual([
      [null, "8.8.8.8", 4],
      [null, [{ address: "8.8.8.8", family: 4 }]],
    ]);
    expect(options).toHaveLength(1);
  } finally {
    requestMock.mockRestore();
  }
  expect(https.request).toBe(originalRequest);
});

test("production stream bridge applies byte backpressure and cancellation before consuming an entire source", async () => {
  const originalRequest = https.request;
  let reads = 0;
  const incoming = new Readable({
    highWaterMark: 16 * 1024,
    read() {
      reads++;
      this.push(Buffer.alloc(16 * 1024));
      if (reads === 64) this.push(null);
    },
  }) as IncomingMessage;
  Object.assign(incoming, { statusCode: 200, rawHeaders: ["content-type", "text/event-stream"] });
  const requestMock = spyOn(https, "request").mockImplementation(((
    _options: https.RequestOptions,
    receive: (value: IncomingMessage) => void,
  ) => {
    const request = new EventEmitter() as ClientRequest;
    request.end = (() => {
      queueMicrotask(() => receive(incoming));
      return request;
    }) as ClientRequest["end"];
    request.destroy = ((error?: Error) => {
      if (error) request.emit("error", error);
      incoming.destroy();
      request.emit("close");
      return request;
    }) as ClientRequest["destroy"];
    incoming.once("close", () => request.emit("close"));
    return request;
  }) as typeof https.request);
  try {
    const response = await createMcpOAuthNetwork(endpoint, { resolver: resolvePublic }).mcpFetch(
      endpoint,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads).toBeLessThanOrEqual(8);
    await response.body?.cancel();
    expect(incoming.destroyed).toBe(true);
  } finally {
    incoming.destroy();
    requestMock.mockRestore();
  }
  expect(https.request).toBe(originalRequest);
});

test("production requester decodes compressed bodies before applying the response byte budget", async () => {
  const originalRequest = https.request;
  const compressed = gzipSync("synthetic-body");
  const requestMock = spyOn(https, "request").mockImplementation(((
    _options: https.RequestOptions,
    receive: (value: IncomingMessage) => void,
  ) => {
    const request = new EventEmitter() as ClientRequest;
    request.end = (() => {
      const incoming = Readable.from([compressed]) as IncomingMessage;
      Object.assign(incoming, {
        statusCode: 200,
        rawHeaders: ["content-encoding", "gzip", "content-length", String(compressed.byteLength)],
      });
      incoming.once("close", () => request.emit("close"));
      queueMicrotask(() => receive(incoming));
      return request;
    }) as ClientRequest["end"];
    request.destroy = ((error?: Error) => {
      if (error) request.emit("error", error);
      request.emit("close");
      return request;
    }) as ClientRequest["destroy"];
    return request;
  }) as typeof https.request);
  try {
    const network = createMcpOAuthNetwork(endpoint, { resolver: resolvePublic });
    const response = await network.oauthFetch(tokenUrl);
    expect(await response.text()).toBe("synthetic-body");
    expect(response.headers.has("content-encoding")).toBe(false);
    expect(response.headers.has("content-length")).toBe(false);
    const small = createMcpOAuthNetwork(endpoint, {
      resolver: resolvePublic,
      oauthResponseBytes: 4,
    });
    await expect(small.oauthFetch(tokenUrl)).rejects.toMatchObject({
      code: "MCP_OAUTH_RESPONSE_LIMIT",
    });
  } finally {
    requestMock.mockRestore();
  }
  expect(https.request).toBe(originalRequest);
});

for (const getStatus of [200, 405]) {
  test(`production Node bridge reads real SDK fragmented gzip SSE tools with GET ${getStatus} and DELETE ${getStatus === 200 ? 405 : 204}`, async () => {
    const originalRequest = https.request;
    const sent: Array<{
      method: string;
      headers: Record<string, string>;
      rpc?: { method: string };
    }> = [];
    const incomingStreams: IncomingMessage[] = [];
    let standalone: IncomingMessage | undefined;
    const requestMock = spyOn(https, "request").mockImplementation(((
      options: https.RequestOptions,
      receive: (value: IncomingMessage) => void,
    ) => {
      const request = new EventEmitter() as ClientRequest;
      let incoming: IncomingMessage | undefined;
      request.end = ((body?: Uint8Array) => {
        const headers = options.headers as Record<string, string>;
        const method = options.method ?? "GET";
        const rpc = body ? JSON.parse(new TextDecoder().decode(body)) : undefined;
        sent.push({ method, headers, rpc });
        let status = 200;
        let rawHeaders: string[] = [];
        if (method === "GET") {
          status = getStatus;
          if (getStatus === 405) incoming = Readable.from([]) as IncomingMessage;
          else {
            let primed = false;
            incoming = new Readable({
              read() {
                if (!primed) {
                  primed = true;
                  this.push(Buffer.from(": synthetic heartbeat\n\n"));
                }
              },
            }) as IncomingMessage;
            standalone = incoming;
            rawHeaders = ["Content-Type", "text/event-stream; charset=utf-8"];
          }
        } else if (method === "DELETE") {
          status = getStatus === 200 ? 405 : 204;
          incoming = Readable.from([]) as IncomingMessage;
        } else if (rpc?.method === "notifications/initialized") {
          status = 202;
          incoming = Readable.from([]) as IncomingMessage;
        } else {
          const result =
            rpc?.method === "initialize"
              ? {
                  protocolVersion: "2025-11-25",
                  capabilities: { tools: {} },
                  serverInfo: { name: "合成串流", version: "1" },
                }
              : {
                  tools: [
                    {
                      name: "synthetic_read",
                      description: "合成唯讀工具喵",
                      inputSchema: { type: "object" },
                      annotations: { readOnlyHint: true },
                    },
                  ],
                };
          const event = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })}\n\n`;
          const compressed = gzipSync(event);
          const pieces: Buffer[] = [];
          for (let offset = 0; offset < compressed.length; offset += 7)
            pieces.push(compressed.subarray(offset, offset + 7));
          incoming = Readable.from(pieces) as IncomingMessage;
          rawHeaders = [
            "Content-Type",
            "text/event-stream; charset=utf-8",
            "Content-Encoding",
            "gzip",
            "Content-Length",
            String(compressed.length),
            "Mcp-Session-Id",
            "synthetic-session",
          ];
        }
        Object.assign(incoming, { statusCode: status, rawHeaders });
        incomingStreams.push(incoming);
        incoming.once("close", () => request.emit("close"));
        queueMicrotask(() => {
          if (incoming) receive(incoming);
        });
        return request;
      }) as ClientRequest["end"];
      request.destroy = ((error?: Error) => {
        if (error) request.emit("error", error);
        incoming?.destroy();
        request.emit("close");
        return request;
      }) as ClientRequest["destroy"];
      return request;
    }) as typeof https.request);
    const client = new Client({ name: "synthetic-production-stream-client", version: "1" });
    const network = createMcpOAuthNetwork(endpoint, { resolver: resolvePublic });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      fetch: network.fetch,
      requestInit: {
        headers: {
          Authorization: "Bearer synthetic-mcp-token",
          "X-Synthetic-Key": "synthetic-key",
        },
      },
    });
    try {
      await client.connect(transport, { timeout: 1000 });
      expect(await client.listTools({}, { timeout: 1000 })).toMatchObject({
        tools: [{ name: "synthetic_read", description: "合成唯讀工具喵" }],
      });
      expect(transport.sessionId).toBe("synthetic-session");
      const listing = sent.find((request) => request.rpc?.method === "tools/list");
      expect(listing?.headers).toMatchObject({
        authorization: "Bearer synthetic-mcp-token",
        "mcp-session-id": "synthetic-session",
        "mcp-protocol-version": "2025-11-25",
        "x-synthetic-key": "synthetic-key",
        accept: "application/json, text/event-stream",
      });
      expect(sent.filter((request) => request.rpc?.method === "tools/list")).toHaveLength(1);
      expect(sent.find((request) => request.method === "GET")?.headers).toMatchObject({
        "mcp-session-id": "synthetic-session",
        accept: "text/event-stream",
      });
      await transport.terminateSession();
      expect(transport.sessionId).toBeUndefined();
      expect(sent.find((request) => request.method === "DELETE")?.headers).toMatchObject({
        authorization: "Bearer synthetic-mcp-token",
        "mcp-session-id": "synthetic-session",
        "mcp-protocol-version": "2025-11-25",
      });
      await client.close();
      if (getStatus === 200) expect(standalone?.destroyed).toBe(true);
      else expect(standalone).toBeUndefined();
    } finally {
      await client.close();
      for (const incoming of incomingStreams) incoming.destroy();
      requestMock.mockRestore();
    }
    expect(https.request).toBe(originalRequest);
  });
}

test("exact MCP endpoint keeps explicit custom headers while OAuth dispatcher and oauthFetch isolate them", async () => {
  const requests: McpOAuthPinnedRequest[] = [];
  const network = fakeNetwork(async (request) => {
    requests.push(request);
    return new Response("{}");
  });
  const headers = {
    Authorization: "Bearer synthetic-mcp-token",
    Cookie: "synthetic-cookie",
    "X-API-Key": "synthetic-key",
    "Mcp-Session-Id": "synthetic-session",
    "Last-Event-ID": "synthetic-event",
    Host: "private-host",
    "Content-Length": "9000",
    "Proxy-Authorization": "synthetic-proxy",
    Connection: "keep-alive",
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
    "Mcp-Protocol-Version": "2025-11-25",
  };
  await network.fetch(endpoint, { method: "POST", headers, body: jsonRpc("initialize") });
  await network.fetch(tokenUrl, { method: "POST", headers, body: "grant_type=authorization_code" });
  await network.oauthFetch(endpoint, { method: "POST", headers, body: "grant_type=refresh_token" });
  expect(requests[0]?.headers.get("authorization")).toBe(headers.Authorization);
  expect(requests[0]?.headers.get("x-api-key")).toBe(headers["X-API-Key"]);
  expect(requests[0]?.headers.get("cookie")).toBe(headers.Cookie);
  for (const request of requests.slice(1))
    expect(Object.fromEntries(request.headers)).toEqual({
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "mcp-protocol-version": "2025-11-25",
    });
  for (const key of ["host", "content-length", "proxy-authorization", "connection"])
    expect(requests[0]?.headers.has(key)).toBe(false);
  await expect(
    network.mcpFetch("https://other.example.com/mcp", { headers }),
  ).rejects.toMatchObject({ code: "MCP_OAUTH_URL_BLOCKED" });
  await expect(network.mcpFetch(`${endpoint}/other`, { headers })).rejects.toMatchObject({
    code: "MCP_OAUTH_URL_BLOCKED",
  });
  expect(requests).toHaveLength(3);
});

test("redirect responses are cancelled and never followed for either MCP or OAuth", async () => {
  for (const mcp of [false, true]) {
    let calls = 0;
    let cancelled = 0;
    const network = fakeNetwork(async () => {
      calls++;
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
        {
          status: 307,
          headers: { location: "http://127.0.0.1/private?synthetic-secret=1" },
        },
      );
    });
    await expect(
      (mcp ? network.mcpFetch : network.oauthFetch)(mcp ? endpoint : tokenUrl, {
        redirect: "follow",
      }),
    ).rejects.toMatchObject({ code: "MCP_OAUTH_REDIRECT_BLOCKED" });
    expect(calls).toBe(1);
    expect(cancelled).toBe(1);
  }
});

test("authorization targets get public URL and DNS validation without issuing requests or exposing their query", async () => {
  let calls = 0;
  const network = fakeNetwork(async () => {
    calls++;
    return new Response("{}");
  });
  expect(
    (
      await network.validateAuthorizationTarget(
        "https://auth.example.com/authorize?state=synthetic&code_challenge=synthetic",
      )
    ).pathname,
  ).toBe("/authorize");
  await expect(
    network.validateAuthorizationTarget("https://[fd00::1]/authorize?state=synthetic-private"),
  ).rejects.toMatchObject({ code: "MCP_OAUTH_DNS_BLOCKED" });
  expect(calls).toBe(0);
});

test("oversized and streaming request bodies fail before DNS or dispatch", async () => {
  let calls = 0;
  const network = fakeNetwork(async () => {
    calls++;
    return new Response("{}");
  });
  for (const body of [
    "喵".repeat(MCP_OAUTH_NETWORK_LIMITS.requestBytes / 2),
    new Uint8Array(MCP_OAUTH_NETWORK_LIMITS.requestBytes + 1),
    new ReadableStream(),
  ])
    await expect(network.oauthFetch(tokenUrl, { method: "POST", body })).rejects.toMatchObject({
      code: "MCP_OAUTH_REQUEST_LIMIT",
    });
  await expect(
    network.oauthFetch(tokenUrl, { method: "GET", body: "synthetic" }),
  ).rejects.toMatchObject({ code: "MCP_OAUTH_REQUEST_LIMIT" });
  expect(calls).toBe(0);
});

test("response limits guard content length and streaming bytes and cancel upstream", async () => {
  for (const announced of [true, false]) {
    let cancelled = 0;
    const network = createMcpOAuthNetwork(endpoint, {
      resolver: resolvePublic,
      oauthResponseBytes: 4,
      requester: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode("12345"));
            },
            cancel() {
              cancelled++;
            },
          }),
          { headers: announced ? { "content-length": "5" } : {} },
        ),
    });
    await expect(network.oauthFetch(tokenUrl)).rejects.toMatchObject({
      code: "MCP_OAUTH_RESPONSE_LIMIT",
    });
    expect(cancelled).toBe(1);
  }
});

test("MCP SSE returns before reading, preserves status/headers and remains open beyond header timeout", async () => {
  let pulls = 0;
  const source = deferred<Uint8Array>();
  const network = createMcpOAuthNetwork(endpoint, {
    resolver: resolvePublic,
    timeoutMs: 5,
    requester: async () =>
      new Response(
        new ReadableStream(
          {
            async pull(controller) {
              pulls++;
              controller.enqueue(await source.promise);
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "text/event-stream", "mcp-session-id": "synthetic-session" } },
      ),
  });
  const response = await network.mcpFetch(endpoint, {
    method: "POST",
    body: jsonRpc("tools/list"),
  });
  expect(pulls).toBe(0);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  expect(response.headers.get("mcp-session-id")).toBe("synthetic-session");
  await new Promise((resolve) => setTimeout(resolve, 20));
  source.resolve(encoder.encode("data: synthetic\n\n"));
  expect(await response.text()).toBe("data: synthetic\n\n");
  expect(pulls).toBe(1);
});

test("MCP GET streams are bounded and propagate cancellation without eagerly consuming bytes", async () => {
  let pulled = 0;
  let cancelled = 0;
  const network = createMcpOAuthNetwork(endpoint, {
    resolver: resolvePublic,
    mcpResponseBytes: 4,
    requester: async () =>
      new Response(
        new ReadableStream(
          {
            pull(controller) {
              pulled++;
              controller.enqueue(encoder.encode("12345"));
            },
            cancel() {
              cancelled++;
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  const response = await network.mcpFetch(endpoint);
  expect(pulled).toBe(0);
  await expect(response.text()).rejects.toMatchObject({ code: "MCP_OAUTH_RESPONSE_LIMIT" });
  expect(pulled).toBe(1);
  expect(cancelled).toBe(1);
});

test("MCP abort cancels an unread upstream stream and a subsequent read fails safely", async () => {
  let cancelled = 0;
  const abort = new AbortController();
  const network = fakeNetwork(
    async () =>
      new Response(
        new ReadableStream(
          {
            cancel() {
              cancelled++;
            },
          },
          { highWaterMark: 0 },
        ),
      ),
  );
  const response = await network.mcpFetch(endpoint, { signal: abort.signal });
  abort.abort(new Error("synthetic-private-abort"));
  await expect(response.text()).rejects.toMatchObject({ code: "MCP_OAUTH_ABORTED" });
  expect(cancelled).toBe(1);
});

test("DNS and response headers have deadlines and a late response body is retired", async () => {
  const dns = deferred<Array<typeof publicAddress>>();
  let calls = 0;
  const unresolved = createMcpOAuthNetwork(endpoint, {
    timeoutMs: 5,
    resolver: () => dns.promise,
    requester: async () => {
      calls++;
      return new Response("{}");
    },
  });
  await expect(unresolved.oauthFetch(tokenUrl)).rejects.toMatchObject({
    code: "MCP_OAUTH_NETWORK_TIMEOUT",
  });
  dns.resolve([publicAddress]);
  await Promise.resolve();
  expect(calls).toBe(0);
  const late = deferred<Response>();
  let cancelled = 0;
  const missingHeaders = createMcpOAuthNetwork(endpoint, {
    timeoutMs: 5,
    resolver: resolvePublic,
    requester: () => late.promise,
  });
  await expect(missingHeaders.mcpFetch(endpoint)).rejects.toMatchObject({
    code: "MCP_OAUTH_NETWORK_TIMEOUT",
  });
  late.resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
        },
      }),
    ),
  );
  await Promise.resolve();
  expect(cancelled).toBe(1);
});

test("OAuth deadline includes stalled response bodies unlike the MCP header-only deadline", async () => {
  let cancelled = 0;
  const network = createMcpOAuthNetwork(endpoint, {
    resolver: resolvePublic,
    timeoutMs: 5,
    requester: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
      ),
  });
  await expect(network.oauthFetch(tokenUrl)).rejects.toMatchObject({
    code: "MCP_OAUTH_NETWORK_TIMEOUT",
  });
  expect(cancelled).toBe(1);
});

test("tools/call 401 and valid Bearer insufficient_scope 403 throw before SDK reauthentication or retry", async () => {
  for (const challenge of [
    { status: 401, header: undefined, code: "MCP_AUTH_REQUIRED" },
    {
      status: 403,
      header: 'Bearer error="insufficient_scope", scope="synthetic"',
      code: "MCP_AUTH_SCOPE_REQUIRED",
    },
    {
      status: 403,
      header: 'Basic realm="synthetic", Bearer realm="synthetic,realm", error=insufficient_scope',
      code: "MCP_AUTH_SCOPE_REQUIRED",
    },
  ]) {
    let requests = 0;
    let auth = 0;
    const network = fakeNetwork(async () => {
      requests++;
      return new Response("synthetic-private-error", {
        status: challenge.status,
        headers: challenge.header ? { "www-authenticate": challenge.header } : {},
      });
    });
    const provider: OAuthClientProvider = {
      redirectUrl: "http://127.0.0.1/synthetic-callback",
      clientMetadata: { redirect_uris: ["http://127.0.0.1/synthetic-callback"] },
      tokens: () => ({
        access_token: "synthetic-token",
        token_type: "Bearer",
        refresh_token: "synthetic-refresh",
      }),
      clientInformation: () => {
        auth++;
        return { client_id: "synthetic-client" };
      },
      saveTokens: () => {
        auth++;
      },
      redirectToAuthorization: () => {
        auth++;
      },
      saveCodeVerifier: () => {
        auth++;
      },
      codeVerifier: () => "synthetic-verifier",
    };
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      fetch: network.fetch,
      authProvider: provider,
    });
    await transport.start();
    try {
      await expect(
        transport.send({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "synthetic" },
        }),
      ).rejects.toMatchObject({ code: challenge.code });
      expect(requests).toBe(1);
      expect(auth).toBe(0);
    } finally {
      await transport.close();
    }
  }
});

test("authentication guard recognizes byte bodies and batches but is confined to tools/call at the exact MCP endpoint", async () => {
  const network = fakeNetwork(async () => new Response("{}", { status: 401 }));
  for (const body of [
    encoder.encode(jsonRpc()),
    JSON.stringify([{ jsonrpc: "2.0", id: 2, method: "tools/call" }]),
  ])
    await expect(network.mcpFetch(endpoint, { method: "POST", body })).rejects.toMatchObject({
      code: "MCP_AUTH_REQUIRED",
    });
  expect(
    (await network.mcpFetch(endpoint, { method: "POST", body: jsonRpc("initialize") })).status,
  ).toBe(401);
  expect((await network.oauthFetch(tokenUrl, { method: "POST", body: jsonRpc() })).status).toBe(
    401,
  );
});

test("unrelated or malformed 403 authentication headers are preserved rather than inventing a scope upgrade", async () => {
  for (const header of [
    'Basic error="insufficient_scope"',
    'Bearer realm="error=insufficient_scope"',
    'Bearer error="access_denied"',
    'Bearer error="insufficient_scope", error="insufficient_scope"',
    'Bearer error="insufficient_scope',
    'Bearer error="insufficient_scope" trailing',
  ]) {
    const network = fakeNetwork(
      async () => new Response("{}", { status: 403, headers: { "www-authenticate": header } }),
    );
    expect((await network.mcpFetch(endpoint, { method: "POST", body: jsonRpc() })).status).toBe(
      403,
    );
  }
});

test("private network errors are replaced by short stable codes and policy injection cannot relax hard bounds", async () => {
  const network = fakeNetwork(async () => {
    throw Object.assign(new Error("synthetic-private-url?secret=1"), {
      stderr: "synthetic-private-stderr",
    });
  });
  try {
    await network.oauthFetch(tokenUrl);
    throw new Error("Expected network rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(McpOAuthNetworkError);
    expect(error).toMatchObject({ code: "MCP_OAUTH_NETWORK_FAILED" });
    expect(String(error)).not.toContain("synthetic-private");
    expect(JSON.stringify(error)).not.toContain("synthetic-private");
  }
  for (const options of [
    { timeoutMs: 30_001 },
    { oauthResponseBytes: MCP_OAUTH_NETWORK_LIMITS.oauthResponseBytes + 1 },
    { mcpResponseBytes: MCP_OAUTH_NETWORK_LIMITS.mcpResponseBytes + 1 },
    { timeoutMs: 0 },
  ])
    expect(() => createMcpOAuthNetwork(endpoint, options)).toThrow(McpOAuthNetworkError);
});
