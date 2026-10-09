import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type https from "node:https";
import { LIMITS } from "@kairomes/protocol";
import { onePixelPng, streamOf } from "./__fixtures__/images.ts";
import {
  checkFileReference,
  downloadOpenAIFile,
  type FileLookup,
  type FileTransport,
  type PinnedFileRequest,
  parseOpenAIFileUrl,
  pinnedHttpsTransport,
  trustedOpenAIFileHost,
  unsafeNetworkAddress,
} from "./openai-file-download.ts";

const reference = {
  download_url: "https://files.oaiusercontent.com/file-fixture/signed-image?sig=fixture",
  file_id: "file_fixture",
  mime_type: "image/png",
  file_name: "fixture.png",
};

/** Resolves each host to a fixed answer; records every lookup. */
function lookupOf(answers: Record<string, string[]>) {
  const asked: string[] = [];
  const lookup: FileLookup = async (hostname) => {
    asked.push(hostname);
    return (answers[hostname] ?? ["93.184.216.34"]).map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));
  };
  return { lookup, asked };
}

/** Answers each request in order; records the URL and the pinned address. */
function transportOf(...responses: Array<(request: PinnedFileRequest) => Response>) {
  const requests: Array<{ url: string; address: string }> = [];
  const transport: FileTransport = async (request) => {
    requests.push({ url: request.url.toString(), address: request.address.address });
    const next = responses[requests.length - 1];
    if (!next) throw new Error("unexpected request");
    return next(request);
  };
  return { transport, requests };
}

const ok =
  (body: BodyInit | null = onePixelPng, init: ResponseInit = {}) =>
  () =>
    new Response(body, { status: 200, ...init });
const redirect = (location: string) => () =>
  new Response(null, { status: 302, headers: { Location: location } });

test("only HTTPS URLs on OpenAI-owned file hosts are accepted", () => {
  expect(parseOpenAIFileUrl(reference.download_url).hostname).toBe("files.oaiusercontent.com");
  for (const value of [
    "https://sdmntprwestus.oaiusercontent.com/files/00000000/raw?sig=fixture",
    "https://chatgpt.com/backend-api/estuary/content?id=file_fixture&sig=fixture",
    "https://chatgpt.com/backend-api/files/file_fixture/content",
    "https://persistent.oaistatic.com/chatgpt-image.png",
    "https://oaidalleapiprodscus.blob.core.windows.net/private/image.png?sig=fixture",
  ])
    expect(trustedOpenAIFileHost(parseOpenAIFileUrl(value).hostname)).toBe(true);
  for (const value of [
    "http://files.oaiusercontent.com/file",
    "https://127.0.0.1/file",
    "https://[::1]/file",
    "https://files.oaiusercontent.com.evil.example/file",
    "https://oaiusercontent.com.evil.example/file",
    "https://evil-oaiusercontent.com/file",
    "https://files.oaiusercontent.com./file",
    "https://user:secret@files.oaiusercontent.com/file",
    "https://files.oaiusercontent.com:444/file",
    "https://files.oaiusercontent.com/file#fragment",
    "https://other.blob.core.windows.net/file",
    "ftp://files.oaiusercontent.com/file",
    "/mnt/data/generated.png",
    "sandbox:/mnt/data/generated.png",
    "file:///mnt/data/generated.png",
    `data:image/png;base64,${onePixelPng.toString("base64")}`,
    onePixelPng.toString("base64"),
  ])
    expect(() => parseOpenAIFileUrl(value)).toThrow(
      expect.objectContaining({ code: "IMPORT_SOURCE_REJECTED" }),
    );
  for (const invalid of [
    { ...reference, download_url: "" },
    { ...reference, download_url: `${reference.download_url}${"x".repeat(4096)}` },
    { ...reference, file_id: "" },
    { ...reference, file_id: "f".repeat(513) },
    { ...reference, mime_type: "m".repeat(201) },
    { ...reference, file_name: "n".repeat(256) },
  ])
    expect(() => checkFileReference(invalid)).toThrow(
      expect.objectContaining({ code: "IMPORT_SOURCE_REJECTED" }),
    );
});

test("private, local, CGNAT, multicast and other non-global addresses are rejected", () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "100.127.255.254",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.8",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "239.255.255.250",
    "255.255.255.255",
    "::",
    "::1",
    "::127.0.0.1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "64:ff9b::7f00:1",
    "64:ff9b:1::1",
    "100::1",
    "2001::1",
    "2001:db8::1",
    "2002:c000:0204::1",
    "3fff::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fe80::1%eth0",
    "fec0::1",
    "ff02::1",
    "not-an-address",
  ])
    expect([address, unsafeNetworkAddress(address)]).toEqual([address, true]);
  for (const address of [
    "93.184.216.34",
    "104.18.0.1",
    "2606:4700:4700::1111",
    "2a00:1450:4001::200e",
    "::ffff:93.184.216.34",
    "64:ff9b::5db8:d822",
  ])
    expect([address, unsafeNetworkAddress(address)]).toEqual([address, false]);
});

test("downloads pin the connection to the checked address and re-check every redirect", async () => {
  const { lookup, asked } = lookupOf({
    "files.oaiusercontent.com": ["93.184.216.34", "2606:4700:4700::1111"],
    "chatgpt.com": ["104.18.0.1"],
  });
  const { transport, requests } = transportOf(
    redirect("https://chatgpt.com/backend-api/estuary/content?id=file_fixture"),
    ok(),
  );
  const data = await downloadOpenAIFile(reference, { lookup, transport });
  expect(data).toEqual(onePixelPng);
  expect(asked).toEqual(["files.oaiusercontent.com", "chatgpt.com"]);
  expect(requests).toEqual([
    { url: reference.download_url, address: "93.184.216.34" },
    {
      url: "https://chatgpt.com/backend-api/estuary/content?id=file_fixture",
      address: "104.18.0.1",
    },
  ]);
});

test("unsafe DNS answers and redirects stop before any request reaches them", async () => {
  for (const answers of [["10.0.0.5"], ["93.184.216.34", "127.0.0.1"], ["::1"], []]) {
    const { transport, requests } = transportOf(ok());
    await expect(
      downloadOpenAIFile(reference, {
        lookup: lookupOf({ "files.oaiusercontent.com": answers }).lookup,
        transport,
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_FILE_HOST" });
    expect(requests).toHaveLength(0);
  }

  for (const location of [
    "http://files.oaiusercontent.com/private",
    "https://127.0.0.1/private",
    "https://attacker.example/image.png",
    "https://files.oaiusercontent.com.attacker.example/image.png",
    "file:///etc/passwd",
  ]) {
    const { transport, requests } = transportOf(redirect(location), ok());
    await expect(
      downloadOpenAIFile(reference, { lookup: lookupOf({}).lookup, transport }),
    ).rejects.toMatchObject({ code: "FILE_REDIRECT_BLOCKED" });
    expect(requests).toHaveLength(1);
  }

  // An allowed redirect host that resolves to a private address is refused too.
  const rebound = transportOf(redirect("https://persistent.oaistatic.com/image.png"), ok());
  await expect(
    downloadOpenAIFile(reference, {
      lookup: lookupOf({ "persistent.oaistatic.com": ["169.254.169.254"] }).lookup,
      transport: rebound.transport,
    }),
  ).rejects.toMatchObject({ code: "UNSAFE_FILE_HOST" });
  expect(rebound.requests).toHaveLength(1);

  const loop = transportOf(
    redirect("https://files.oaiusercontent.com/a"),
    redirect("https://files.oaiusercontent.com/b"),
    redirect("https://files.oaiusercontent.com/c"),
    ok(),
  );
  await expect(
    downloadOpenAIFile(reference, { lookup: lookupOf({}).lookup, transport: loop.transport }),
  ).rejects.toMatchObject({ code: "FILE_REDIRECT_BLOCKED" });
  expect(loop.requests).toHaveLength(3);
});

test("HTML or JSON bodies are refused by their bytes whatever the Content-Type says", async () => {
  for (const [body, type] of [
    ["<!doctype html><html><body>Sign in</body></html>", "image/png"],
    ['{"detail":"File not found"}', "application/json"],
    ["<html>", "text/html"],
  ] as const) {
    const { transport } = transportOf(ok(body, { headers: { "Content-Type": type } }));
    await expect(
      downloadOpenAIFile(reference, { lookup: lookupOf({}).lookup, transport }),
    ).rejects.toMatchObject({ code: "IMPORT_NOT_IMAGE" });
  }
  // A large HTML page stops after its first chunk instead of being read to the end.
  const page = streamOf(LIMITS.artifactBytes, Buffer.from("<!doctype html><html>"));
  const { transport } = transportOf(ok(page.stream));
  await expect(
    downloadOpenAIFile(reference, { lookup: lookupOf({}).lookup, transport }),
  ).rejects.toMatchObject({ code: "IMPORT_NOT_IMAGE" });
  expect(page.sent()).toBeLessThan(4 * 1024 * 1024);
});

test("downloads are bounded by status, size, time and cancellation", async () => {
  const lookup = lookupOf({}).lookup;
  const status = transportOf(() => new Response("forbidden", { status: 403 }));
  const forbidden = await downloadOpenAIFile(reference, { lookup, transport: status.transport })
    .then(() => undefined)
    .catch((error: unknown) => error);
  expect(forbidden).toMatchObject({ code: "FILE_DOWNLOAD_FAILED" });
  expect(JSON.stringify(forbidden)).not.toContain("forbidden");

  const declared = transportOf(
    ok("x", { headers: { "Content-Length": String(LIMITS.artifactBytes + 1) } }),
  );
  await expect(
    downloadOpenAIFile(reference, { lookup, transport: declared.transport }),
  ).rejects.toMatchObject({ code: "ARTIFACT_TOO_LARGE" });

  const total = LIMITS.artifactBytes + 4 * 1024 * 1024;
  const chunked = streamOf(total);
  await expect(
    downloadOpenAIFile(reference, { lookup, transport: transportOf(ok(chunked.stream)).transport }),
  ).rejects.toMatchObject({ code: "ARTIFACT_TOO_LARGE" });
  expect(chunked.sent()).toBeLessThan(total);

  await expect(
    downloadOpenAIFile(reference, {
      lookup,
      transport: transportOf(ok(new Uint8Array())).transport,
    }),
  ).rejects.toMatchObject({ code: "FILE_DOWNLOAD_FAILED" });

  const hanging: FileTransport = ({ signal }) =>
    new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("abort"))));
  await expect(
    downloadOpenAIFile(reference, { lookup, transport: hanging, timeoutMs: 20 }),
  ).rejects.toMatchObject({ code: "FILE_DOWNLOAD_TIMEOUT" });

  const cancel = new AbortController();
  const cancelled = downloadOpenAIFile(reference, {
    lookup,
    transport: hanging,
    signal: cancel.signal,
  });
  cancel.abort();
  await expect(cancelled).rejects.toMatchObject({ code: "IMPORT_CANCELLED" });

  // Network errors can name hosts or addresses; only a fixed category is reported.
  const failing: FileTransport = async () => {
    throw new Error("connect ECONNREFUSED 93.184.216.34:443 files.oaiusercontent.com");
  };
  const network = await downloadOpenAIFile(reference, { lookup, transport: failing })
    .then(() => undefined)
    .catch((error: unknown) => error);
  expect(network).toMatchObject({ code: "FILE_DOWNLOAD_FAILED" });
  expect(String((network as Error).message)).not.toContain("93.184.216.34");
});

test("the default transport connects only to the checked address and keeps TLS name checks", async () => {
  type Options = https.RequestOptions & {
    lookup: (
      host: string,
      options: { all?: boolean },
      callback: (...args: unknown[]) => void,
    ) => void;
  };
  let captured: Options | undefined;
  const fakeRequest = ((options: Options, callback: (message: unknown) => void) => {
    captured = options;
    const outgoing = Object.assign(new EventEmitter(), {
      end() {
        const message = Object.assign(new EventEmitter(), {
          statusCode: 200,
          headers: { "content-type": "image/png" },
          resume() {},
          destroy() {},
        });
        callback(message);
        queueMicrotask(() => {
          message.emit("data", Buffer.from(onePixelPng));
          message.emit("end");
        });
      },
      destroy() {},
    });
    return outgoing;
  }) as unknown as typeof https.request;
  const transport = pinnedHttpsTransport(fakeRequest);
  const response = await transport({
    url: new URL(reference.download_url),
    address: { address: "93.184.216.34", family: 4 },
    signal: new AbortController().signal,
  });
  expect(Buffer.from(await response.arrayBuffer())).toEqual(onePixelPng);
  expect(captured).toMatchObject({
    protocol: "https:",
    hostname: "files.oaiusercontent.com",
    servername: "files.oaiusercontent.com",
    port: 443,
    path: "/file-fixture/signed-image?sig=fixture",
    method: "GET",
    agent: false,
  });
  expect(
    Object.keys(captured?.headers ?? {})
      .map((name) => name.toLowerCase())
      .sort(),
  ).toEqual(["accept", "accept-encoding"]);
  const answers: unknown[] = [];
  captured?.lookup("files.oaiusercontent.com", { all: true }, (...args) => answers.push(args));
  captured?.lookup("files.oaiusercontent.com", {}, (...args) => answers.push(args));
  captured?.lookup("rebound.example", { all: true }, (...args) => answers.push(args));
  expect(answers[0]).toEqual([null, [{ address: "93.184.216.34", family: 4 }]]);
  expect(answers[1]).toEqual([null, "93.184.216.34", 4]);
  expect((answers[2] as unknown[])[0]).toBeInstanceOf(Error);
});
