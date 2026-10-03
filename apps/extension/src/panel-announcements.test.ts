import { expect, test } from "bun:test";
import { PanelAnnouncements } from "./panel-announcements.ts";

test("connection snapshots cannot replace pending announcements or repeatedly announce idle state", () => {
  const connections: string[] = [];
  const approvals: string[] = [];
  const live = new PanelAnnouncements(
    (message) => connections.push(message),
    (message) => approvals.push(message),
  );
  live.approvals([]);
  live.connection("本機已連接");
  live.approvals(["command-one"]);
  live.connection("本機已連接");
  live.approvals(["command-one"]);
  live.connection("本機已連接");
  expect(connections).toEqual(["本機已連接"]);
  expect(approvals).toEqual(["需確認 1 件"]);
  live.connection("本機重連中");
  live.approvals(["command-one"]);
  live.connection("本機已連接");
  expect(approvals).toEqual(["需確認 1 件"]);
  expect(connections).toEqual(["本機已連接", "本機重連中", "本機已連接"]);
});

test("a replacement request is announced even when the queue length stays the same", () => {
  const messages: string[] = [];
  const live = new PanelAnnouncements(
    () => {},
    (message) => messages.push(message),
  );
  live.approvals(["one", "two"]);
  live.approvals(["two", "one"]);
  live.approvals(["two", "three"]);
  live.approvals([]);
  live.approvals([]);
  expect(messages).toEqual(["需確認 2 件", "需確認 2 件", "待確認清單已清空"]);
});
