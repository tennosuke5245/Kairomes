import { expect, test } from "bun:test";
import path from "node:path";
import type { ArtifactImportApproval } from "@kairomes/protocol";
import { fixture } from "../../../tests/fixtures.ts";
import { approvalPage } from "./approval-page.ts";
import { startCompanion } from "./preview.ts";
import { ToolService } from "./tools.ts";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("the legacy approval page neither lists nor decides image imports", async () => {
  // The page has no image review; it only renders changes, commands and terminals.
  for (const marker of ["import_id", "data.imports", "source_file_id"])
    expect(approvalPage).not.toContain(marker);
  for (const marker of ["change_id", "command_id", "session_id", "data.changes"])
    expect(approvalPage).toContain(marker);

  const f = await fixture();
  const service = new ToolService(f.registry, false, {
    artifactDownload: async () => Buffer.from(onePixelPng),
  });
  const app = startCompanion(service);
  try {
    const admin = new URL(app.approvalsUrl);
    const token = new URLSearchParams(admin.hash.slice(1)).get("session") ?? "";
    const post = (body: unknown) =>
      fetch(`${admin.origin}/api/approvals`, {
        method: "POST",
        headers: {
          Origin: admin.origin,
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
    const served = await (await fetch(`${admin.origin}/approvals`)).text();
    expect(served).toBe(approvalPage);

    const request = async (target: string) =>
      (
        await service.imports.request(
          {
            workspace_id: f.workspace.id,
            request_id: crypto.randomUUID(),
            path: target,
            summary: "保存圖片",
            file: {
              download_url: "https://files.oaiusercontent.com/file-fixture/signed",
              file_id: "file_fixture",
            },
          },
          "mcp",
        )
      ).image_import;
    const settled = async (id: string) => {
      while (service.imports.poll(id).image_import.state === "preparing") await Bun.sleep(5);
    };
    const pending = await request("generated.png");
    await settled(pending.id);
    const list = await (await post({ action: "list" })).json();
    expect(list.importHydration).toEqual({ hydrated: 1, omitted: 0, rejected: 0 });
    const review = (list.imports as ArtifactImportApproval[]).find(
      (item) => item.id === pending.id,
    );
    expect(review?.state).toBe("pending");

    // The admin token cannot approve an import, whoever holds it.
    const approve = await post({
      action: "approve",
      import_id: pending.id,
      fingerprint: review?.fingerprint,
    });
    expect(approve.status).toBe(400);
    expect(await approve.json()).toMatchObject({ code: "IMPORT_APPROVAL_PANEL_ONLY" });
    expect(service.imports.poll(pending.id).image_import.state).toBe("pending");
    expect(await Bun.file(path.join(f.root, "generated.png")).exists()).toBe(false);

    // Denying (with a reason) or stopping only reduces what can happen and stays available.
    const denied = await post({
      action: "deny",
      import_id: pending.id,
      fingerprint: review?.fingerprint,
      reason: " 換一張圖 ",
    });
    expect(denied.status).toBe(200);
    expect(service.imports.poll(pending.id).image_import).toMatchObject({
      state: "denied",
      denial_reason: "換一張圖",
    });
    const second = await request("second.png");
    await settled(second.id);
    expect((await post({ action: "stop", import_id: second.id })).status).toBe(200);
    expect(service.imports.poll(second.id).image_import.state).toBe("cancelled");

    // The paired panel's path (the same service call without the admin gate) still approves,
    // once that panel has read the pending bytes.
    const third = await request("third.png");
    await settled(third.id);
    const thirdReview = service.imports.approvals().find((item) => item.id === third.id);
    const panelToken = "c".repeat(64);
    const approveThird = () =>
      service.decideApproval(
        { action: "approve", import_id: third.id, fingerprint: thirdReview?.fingerprint ?? "" },
        panelToken,
      );
    await expect(approveThird()).rejects.toMatchObject({ code: "IMPORT_PREVIEW_REQUIRED" });
    service.imports.content(third.id, panelToken);
    await approveThird();
    expect(service.imports.poll(third.id).image_import.state).toBe("applied");
    expect(await Bun.file(path.join(f.root, "third.png")).exists()).toBe(true);
  } finally {
    await app.close();
    await f.dispose();
  }
});
