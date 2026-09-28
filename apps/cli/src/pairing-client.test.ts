import { describe, expect, test } from "bun:test";
import { requestPairingUrl } from "./pairing-client.ts";

describe("requestPairingUrl", () => {
  test("sends the local admin credential and returns the one-time URL", async () => {
    let request: { input: string | URL | Request; init?: RequestInit } | undefined;
    const pairingUrl = await requestPairingUrl(
      "http://127.0.0.1:4318",
      "admin-token",
      "abcdefghijklmnopabcdefghijklmnop",
      async (input, init) => {
        request = { input, init };
        return Response.json({ pairingUrl: "http://127.0.0.1:4318/pair#code=one-time" });
      },
    );
    expect(pairingUrl).toBe("http://127.0.0.1:4318/pair#code=one-time");
    expect(String(request?.input)).toBe("http://127.0.0.1:4318/api/pairing/create");
    expect(new Headers(request?.init?.headers).get("authorization")).toBe("Bearer admin-token");
    expect(request?.init?.body).toBe(
      JSON.stringify({ extensionId: "abcdefghijklmnopabcdefghijklmnop" }),
    );
  });

  test("keeps server errors safe and actionable", async () => {
    await expect(
      requestPairingUrl(
        "http://127.0.0.1:4318",
        "admin-token",
        "abcdefghijklmnopabcdefghijklmnop",
        async () => Response.json({ message: "Extension ID 不符。" }, { status: 400 }),
      ),
    ).rejects.toMatchObject({ code: "PAIRING_FAILED", message: "Extension ID 不符。" });
  });
});
