import { expect, test } from "bun:test";
import { followPairing, leavePairing, type PairingLink, receivePairing } from "./pairing.ts";

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const LINK = "http://127.0.0.1:43111/pair#code=synthetic-one-time-code";
const result = { pairingUrl: LINK, expiresInSeconds: 120 };

test("a link that arrives after 連線設定 was left is dropped, never kept off-screen", () => {
  expect(receivePairing(result, { onPage: false, pairedPanels: 0, now: NOW })).toBeNull();
  expect(receivePairing({}, { onPage: true, pairedPanels: 0, now: NOW })).toBeNull();
  expect(receivePairing(result, { onPage: true, pairedPanels: 1, now: NOW })).toEqual({
    url: LINK,
    receivedAt: NOW,
    expiresInSeconds: 120,
    pairedAtStart: 1,
  });
});

test("leaving the page clears a live link and keeps a cleared one as it is", () => {
  const live = receivePairing(result, { onPage: true, pairedPanels: 0, now: NOW });
  expect(leavePairing(live)).toMatchObject({ url: "", cleared: "left" });
  expect(leavePairing(null)).toBeNull();
  const expired: PairingLink = { url: "", receivedAt: NOW, pairedAtStart: 0, cleared: "expired" };
  expect(leavePairing(expired)).toBe(expired);
});

test("a link expires on time and is marked used when a new panel pairs", () => {
  const live = receivePairing(result, { onPage: true, pairedPanels: 0, now: NOW }) as PairingLink;
  expect(followPairing(live, 60_000, 0)).toBe(live);
  expect(followPairing(live, 60_000, null)).toBe(live);
  expect(followPairing(live, 0, 0)).toMatchObject({ url: "", cleared: "expired" });
  expect(followPairing(live, 60_000, 1)).toMatchObject({ url: "", cleared: "used" });
});

test("更換 Extension ID: the workbench restart resets the count, and the link is still noticed", () => {
  // One panel was paired when the link was made; saving the ID restarted the workbench.
  let link = receivePairing(result, { onPage: true, pairedPanels: 1, now: NOW }) as PairingLink;
  link = followPairing(link, 90_000, 0);
  expect(link).toMatchObject({ url: LINK, pairedAtStart: 0 });
  expect(followPairing(link, 90_000, 0)).toBe(link);
  // The new panel pairs: 0 → 1 is above the lowered baseline, so the link is used.
  expect(followPairing(link, 80_000, 1)).toMatchObject({ url: "", cleared: "used" });
});

test("an unknown count at the start is learnt from the first count seen", () => {
  let link = receivePairing(result, { onPage: true, pairedPanels: null, now: NOW }) as PairingLink;
  link = followPairing(link, 90_000, 2);
  expect(link).toMatchObject({ url: LINK, pairedAtStart: 2 });
  expect(followPairing(link, 90_000, 3)).toMatchObject({ cleared: "used" });
});
