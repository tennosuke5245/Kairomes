import { expect, test } from "bun:test";
import { LIMITS } from "@kairomes/protocol";
import {
  downloadOpenAIFile,
  parseOpenAIFileUrl,
  trustedOpenAIFileHost,
  unsafeNetworkAddress,
} from "./openai-file-download.ts";

const reference = {
  download_url: "https://files.oaiusercontent.com/private/signed-image",
  file_id: "file_fixture",
  mime_type: "image/png",
  file_name: "fixture.png",
};
const publicLookup = (async () => [{ address: "93.184.216.34", family: 4 }]) as never;

test("OpenAI file URLs support first-party delivery hosts but never arbitrary downloads", () => {
  expect(parseOpenAIFileUrl(reference.download_url).hostname).toBe("files.oaiusercontent.com");
  for (const value of [
    "https://persistent.oaistatic.com/chatgpt-image.png",
    "https://chatgpt.com/backend-api/files/file_fixture/content",
    "https://oaidalleapiprodscus.blob.core.windows.net/private/image.png?sig=fixture",
  ])
    expect(trustedOpenAIFileHost(parseOpenAIFileUrl(value).hostname)).toBe(true);
  for (const value of [
    "http://files.oaiusercontent.com/file",
    "https://127.0.0.1/file",
    "https://files.oaiusercontent.com.evil.example/file",
    "https://oaistatic.com.evil.example/file",
    "https://user:secret@files.oaiusercontent.com/file",
    "https://files.oaiusercontent.com:444/file",
  ])
    expect(() => parseOpenAIFileUrl(value)).toThrow();

  for (const value of [
    "/mnt/data/generated.png",
    "sandbox:/mnt/data/generated.png",
    "file:///mnt/data/generated.png",
  ])
    expect(() => parseOpenAIFileUrl(value)).toThrow(
      expect.objectContaining({ code: "FILE_REFERENCE_NOT_INJECTED" }),
    );
});

test("private, local, mapped and documentation network addresses are rejected", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
  ])
    expect(unsafeNetworkAddress(address)).toBe(true);
  expect(unsafeNetworkAddress("93.184.216.34")).toBe(false);
  expect(unsafeNetworkAddress("2606:4700:4700::1111")).toBe(false);
});

test("OpenAI file downloads are bounded and only follow trusted redirects", async () => {
  const downloaded = await downloadOpenAIFile(reference, {
    lookup: publicLookup,
    fetch: (async () => new Response(Buffer.from("safe"), { status: 200 })) as never,
  });
  expect(downloaded.toString()).toBe("safe");

  const requested: string[] = [];
  const redirected = await downloadOpenAIFile(reference, {
    lookup: publicLookup,
    fetch: (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return requested.length === 1
        ? new Response(null, {
            status: 302,
            headers: { Location: "https://persistent.oaistatic.com/final-image" },
          })
        : new Response(Buffer.from("redirected"), { status: 200 });
    }) as never,
  });
  expect(redirected.toString()).toBe("redirected");
  expect(requested).toEqual([
    "https://files.oaiusercontent.com/private/signed-image",
    "https://persistent.oaistatic.com/final-image",
  ]);

  await expect(
    downloadOpenAIFile(reference, {
      lookup: publicLookup,
      fetch: (async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "http://127.0.0.1/private" },
        })) as never,
    }),
  ).rejects.toMatchObject({ code: "FILE_REDIRECT_BLOCKED" });

  await expect(
    downloadOpenAIFile(reference, {
      lookup: publicLookup,
      fetch: (async () =>
        new Response("x", {
          headers: { "Content-Length": String(LIMITS.artifactBytes + 1) },
        })) as never,
    }),
  ).rejects.toMatchObject({ code: "ARTIFACT_TOO_LARGE" });
});
