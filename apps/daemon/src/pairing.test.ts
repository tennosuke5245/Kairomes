import { expect, test } from "bun:test";
import { PanelPairing } from "./pairing.ts";

const extensionId = "a".repeat(32);

test("activeCount reports only currently valid panel pairings", () => {
  let now = 1_000_000;
  const pairing = new PanelPairing(extensionId, () => now);
  expect(pairing.activeCount()).toBe(0);
  // An unredeemed code is not a paired panel.
  const first = pairing.create(extensionId);
  expect(pairing.activeCount()).toBe(0);
  const firstToken = pairing.redeem(first);
  const secondToken = pairing.redeem(pairing.create(extensionId));
  expect(pairing.activeCount()).toBe(2);
  // A redeemed code cannot be redeemed again and does not add a pairing.
  expect(() => pairing.redeem(first)).toThrow();
  expect(pairing.activeCount()).toBe(2);
  pairing.revoke(firstToken);
  expect(pairing.activeCount()).toBe(1);
  expect(pairing.valid(secondToken)).toBe(true);
  now += 12 * 60 * 60_000;
  expect(pairing.activeCount()).toBe(0);
  expect(pairing.valid(secondToken)).toBe(false);
  pairing.redeem(pairing.create(extensionId));
  expect(pairing.activeCount()).toBe(1);
  pairing.close();
  expect(pairing.activeCount()).toBe(0);
});
