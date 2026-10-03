import { describe, expect, test } from "bun:test";
import type {
  HandoffBaseline,
  HandoffFields,
  HandoffPreview,
} from "../packages/protocol/src/handoff.ts";
import { createDesktopHandoffApi } from "./desktop-handoff-api.ts";
import { createHandoffStudyApi } from "./handoff-study-api.ts";
import {
  HANDOFF_STUDY_MATERIALS,
  HANDOFF_STUDY_WORKSPACE,
  renderStudyMaterial,
  type StudyMaterialId,
} from "./handoff-study-materials.ts";

type Api = ReturnType<typeof createHandoffStudyApi>;
const call = <T>(api: Api, input: unknown) => api.request("handoff_request", input) as Promise<T>;
const draftId = "00000000-0000-4000-8000-000000000030";
const fixedNow = () => Date.parse("2026-10-02T00:00:00.000Z");
const fields = (id: StudyMaterialId): HandoffFields => {
  const material = HANDOFF_STUDY_MATERIALS[id];
  return {
    goal: material.goal,
    next_action: material.nextAction,
    completed: material.completed.join("\n"),
    decisions: "保留原查詢或選擇。",
    unknowns: material.unknown,
  };
};
async function open(
  api: Api,
  id: StudyMaterialId = "alpha",
  provider: "codex" | "manual" = "codex",
) {
  await call(api, {
    action: "start",
    workspace_id: HANDOFF_STUDY_WORKSPACE.id,
    provider,
    draft_id: draftId,
  });
  if (provider === "codex")
    await call(api, {
      action: "snapshot",
      draft_id: draftId,
      session_id: HANDOFF_STUDY_MATERIALS[id].sessionId,
    });
}
async function preview(
  api: Api,
  id: StudyMaterialId = "alpha",
  attested = true,
  paths = ["src/main.ts", "README.md"],
) {
  await call(api, { action: "baseline", draft_id: draftId, paths });
  return call<HandoffPreview>(api, {
    action: "preview",
    draft_id: draftId,
    fields: fields(id),
    source_stopped: attested,
    permissions_checked: attested,
  });
}
const prepare = (api: Api, digest: string) =>
  call<{ text: string; digest: string; state: string }>(api, {
    action: "prepare",
    draft_id: draftId,
    content_digest: digest,
    source_stopped: true,
    permissions_checked: true,
  });

describe("D10 synthetic handoff evidence", () => {
  test("two immutable equivalent-sized materials have exact hashes, byte counts and one historic difference", () => {
    for (const id of ["alpha", "beta"] as const) {
      const material = HANDOFF_STUDY_MATERIALS[id];
      expect(material.completed).toHaveLength(2);
      expect(material.files).toHaveLength(2);
      expect(
        material.files.filter((file) => file.historical.version !== file.current.version),
      ).toHaveLength(1);
      expect(Object.isFrozen(material)).toBe(true);
      expect(Object.isFrozen(material.files[0].current)).toBe(true);
      const reference = renderStudyMaterial(id);
      for (const value of [
        material.goal,
        ...material.completed,
        material.unknown,
        material.nextAction,
      ])
        expect(reference).toContain(value);
      expect(reference).toContain("歷史檢查時間：未知");
      for (const file of material.files) {
        expect(reference).toContain(file.path);
        for (const version of [
          file.historical,
          file.current,
          ...("edited" in file ? [file.edited] : []),
        ]) {
          expect(new TextEncoder().encode(version.content).length).toBe(version.bytes);
          expect(new Bun.CryptoHasher("sha256").update(version.content).digest("hex")).toBe(
            version.version,
          );
        }
      }
    }
  });

  test("each source exposes the same manual facts through consistent completed messages and complete coverage", async () => {
    for (const id of ["alpha", "beta"] as const) {
      const api = createHandoffStudyApi(id, { now: fixedNow });
      await open(api, id);
      const { snapshot } = await call<{
        snapshot: {
          lastUserRequest: string;
          lastAgentResponse: string;
          completedTurns: { messages: { text: string }[] }[];
          coverage: unknown;
          taskState: unknown;
        };
      }>(api, {
        action: "snapshot",
        draft_id: draftId,
        session_id: HANDOFF_STUDY_MATERIALS[id].sessionId,
      });
      const text = `${snapshot.lastUserRequest}\n${snapshot.lastAgentResponse}`;
      const material = HANDOFF_STUDY_MATERIALS[id];
      for (const value of [
        material.goal,
        ...material.completed,
        material.unknown,
        material.nextAction,
        ...material.files.flatMap((file) => [
          file.path,
          file.historical.version,
          file.current.version,
          file.current.content.trimEnd(),
        ]),
      ])
        expect(text).toContain(value);
      expect(text.split(material.goal)).toHaveLength(2);
      expect(snapshot.completedTurns[0]?.messages.map((message) => message.text)).toEqual([
        snapshot.lastUserRequest,
        snapshot.lastAgentResponse,
      ]);
      expect(snapshot.coverage).toEqual({
        hasOlderTurns: false,
        textTruncated: false,
        itemsTruncated: false,
        recentTurnsRequested: 3,
      });
      expect(snapshot.taskState).toEqual({ goal: null, plan: null, decisions: null });
    }
  });

  test("both cases export every human field and exact selected versions before ready-to-copy", async () => {
    for (const id of ["alpha", "beta"] as const) {
      const api = createHandoffStudyApi(id, { now: fixedNow });
      await open(api, id);
      const result = await preview(api, id);
      expect(result.complete).toBe(true);
      expect(result.blocked_reason).toBeNull();
      for (const value of Object.values(fields(id))) expect(result.text).toContain(value);
      for (const file of HANDOFF_STUDY_MATERIALS[id].files)
        expect(result.text).toContain(`${file.path}: ${file.current.version}`);
      expect(result.text).toContain("performed_at／applicable_baseline：unknown");
      expect(result.text).toContain("合成人工聲明，未驗證原生權限");
      expect(result.text).not.toContain(HANDOFF_STUDY_MATERIALS[id].sessionId);
      expect(result.text).not.toContain("cwd");
      expect(new Bun.CryptoHasher("sha256").update(result.text).digest("hex")).toBe(result.digest);
      expect(await prepare(api, result.digest)).toEqual({
        text: result.text,
        digest: result.digest,
        state: "ready-to-copy",
      });
    }
  });
});

describe("finite synthetic API failure contracts", () => {
  test("strict schemas, workspace, provider source allowlist and cross-material draft identity", async () => {
    const api = createHandoffStudyApi("alpha");
    await expect(api.request("file_read", {})).rejects.toThrow("未提供");
    await expect(
      call(api, {
        action: "start",
        workspace_id: HANDOFF_STUDY_WORKSPACE.id,
        provider: "codex",
        extra: true,
      }),
    ).rejects.toThrow("格式");
    await expect(
      call(api, {
        action: "start",
        workspace_id: "00000000-0000-4000-8000-000000000099",
        provider: "codex",
      }),
    ).rejects.toThrow("專案");
    await open(api);
    await expect(
      call(api, { action: "snapshot", draft_id: draftId, session_id: "study-beta-session" }),
    ).rejects.toThrow("此專案");
    await expect(
      call(api, { action: "list", draft_id: draftId, cursor: "unissued" }),
    ).rejects.toThrow("游標");
    const beta = createHandoffStudyApi("beta");
    await expect(
      call(beta, { action: "baseline", draft_id: draftId, paths: ["README.md"] }),
    ).rejects.toThrow("失效");
    await call(api, { action: "cancel", draft_id: draftId });
    await open(api, "alpha", "manual");
    await expect(
      call(api, { action: "snapshot", draft_id: draftId, session_id: "study-alpha-session" }),
    ).rejects.toThrow("此專案");
    expect((await preview(api)).complete).toBe(true);
  });

  test("duplicate, unsafe and oversized path lists rejected; empty, arbitrary or missing files never ready", async () => {
    const api = createHandoffStudyApi("alpha");
    await open(api);
    for (const paths of [
      ["README.md", "README.md"],
      ["../README.md"],
      ["src\\main.ts"],
      ["/README.md"],
      ["C:/README.md"],
      Array(21).fill("README.md"),
    ])
      await expect(call(api, { action: "baseline", draft_id: draftId, paths })).rejects.toThrow();
    for (const paths of [[], ["not-a-file.txt"], ["src/main.ts", "not-a-file.txt"]]) {
      const checked = await call<HandoffBaseline>(api, {
        action: "baseline",
        draft_id: draftId,
        paths,
      });
      expect(checked.complete).toBe(false);
      expect(checked.total_bytes).toBe(
        paths.includes("src/main.ts") ? HANDOFF_STUDY_MATERIALS.alpha.files[0].current.bytes : 0,
      );
      const result = await preview(api, "alpha", true, paths);
      expect(result.complete).toBe(false);
      await expect(prepare(api, result.digest)).rejects.toThrow("不完整");
    }
    api.control("missing-file");
    const result = await preview(api);
    expect(result.complete).toBe(false);
    const checked = await call<HandoffBaseline>(api, {
      action: "baseline",
      draft_id: draftId,
      paths: ["src/main.ts", "README.md"],
    });
    expect(checked.files[1]).toMatchObject({ state: "unknown", version: null, bytes: null });
    expect(checked.total_bytes).toBe(HANDOFF_STUDY_MATERIALS.alpha.files[0].current.bytes);
  });

  test("new literal attestations cannot replace missing reviewed attestations", async () => {
    const api = createHandoffStudyApi("alpha");
    await open(api);
    const result = await preview(api, "alpha", false);
    await expect(prepare(api, result.digest)).rejects.toThrow("有效權限");
    await expect(prepare(api, result.digest)).rejects.toThrow("失效");
    const checked = await preview(api);
    expect((await prepare(api, checked.digest)).state).toBe("ready-to-copy");
  });

  test("digest tampering invalidates old preview and no false/extra prepare fields are accepted", async () => {
    const api = createHandoffStudyApi("alpha");
    await open(api);
    const result = await preview(api);
    await expect(
      call(api, {
        action: "prepare",
        draft_id: draftId,
        content_digest: result.digest,
        source_stopped: false,
        permissions_checked: true,
      }),
    ).rejects.toThrow("格式");
    await expect(prepare(api, "0".repeat(64))).rejects.toThrow("失效");
    await expect(prepare(api, result.digest)).rejects.toThrow("失效");
    expect((await prepare(api, (await preview(api)).digest)).state).toBe("ready-to-copy");
  });

  test("edited file invalidates reviewed digest, then rechecking restores readiness at current version", async () => {
    const api = createHandoffStudyApi("alpha");
    await open(api);
    const result = await preview(api);
    api.control("edit-file");
    await expect(prepare(api, result.digest)).rejects.toThrow("檔案版本已改變");
    await expect(prepare(api, result.digest)).rejects.toThrow("失效");
    const checked = await preview(api);
    expect(checked.digest).not.toBe(result.digest);
    expect(checked.text).toContain(HANDOFF_STUDY_MATERIALS.alpha.files[0].edited.version);
    expect((await prepare(api, checked.digest)).state).toBe("ready-to-copy");
  });

  test("source pending after preview invalidates baseline; selected pending and unknown never ready", async () => {
    const api = createHandoffStudyApi("alpha");
    await open(api);
    const result = await preview(api);
    api.control("source-pending");
    await expect(prepare(api, result.digest)).rejects.toThrow("進行中");
    await expect(
      call(api, {
        action: "preview",
        draft_id: draftId,
        fields: fields("alpha"),
        source_stopped: true,
        permissions_checked: true,
      }),
    ).rejects.toThrow("先核對");
    const pending = await preview(api);
    expect(pending.complete).toBe(false);
    expect(pending.blocked_reason).toContain("進行中");
    await expect(prepare(api, pending.digest)).rejects.toThrow("進行中");
    const unknown = createHandoffStudyApi("alpha", { sourceStatus: "unknown" });
    await open(unknown);
    const unconfirmed = await preview(unknown);
    expect(unconfirmed.complete).toBe(false);
    await expect(prepare(unknown, unconfirmed.digest)).rejects.toThrow("未知");
  });

  test("coverage flags remain visible without falsely asserting full evidence or blocking an idle finite baseline", async () => {
    const api = createHandoffStudyApi("alpha", { itemsTruncated: true, hasOlderTurns: true });
    await open(api);
    const result = await preview(api);
    expect(result.text).toContain("較舊未含；截斷有");
    expect(result.complete).toBe(true);
  });

  test("private text rejected across all human fields; ordinary public documentation URL accepted", async () => {
    const api = createHandoffStudyApi("alpha");
    await open(api);
    await call(api, { action: "baseline", draft_id: draftId, paths: ["README.md"] });
    for (const [field, value] of [
      ["goal", `sk-${"x".repeat(25)}`],
      ["completed", "C:/synthetic/private.txt"],
      ["decisions", "https://2130706433/fixture"],
      ["unknowns", "https://127.1/fixture"],
      ["next_action", "/home/synthetic/private.txt"],
    ])
      await expect(
        call(api, {
          action: "preview",
          draft_id: draftId,
          fields: { ...fields("alpha"), [field as string]: value },
          source_stopped: true,
          permissions_checked: true,
        }),
      ).rejects.toThrow("請移除");
    const safe = await call<HandoffPreview>(api, {
      action: "preview",
      draft_id: draftId,
      fields: { ...fields("alpha"), decisions: "閱讀 https://example.com/spec" },
      source_stopped: true,
      permissions_checked: true,
    });
    expect(safe.text).toContain("https://example.com/spec");
  });

  test("bounded concurrent starts, duplicate draft, expiration, clone ownership and reset", async () => {
    let clock = fixedNow();
    const api = createHandoffStudyApi("alpha", { now: () => clock });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        call(api, { action: "start", workspace_id: HANDOFF_STUDY_WORKSPACE.id, provider: "codex" }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(4);
    expect(api.getStudyState().activeDrafts).toBe(4);
    const copy = api.getStudyState();
    if (copy.files[0]?.current)
      copy.files[0].current = { content: "wrong", version: "0".repeat(64), bytes: 0 };
    expect(api.getStudyState().files[0]?.current?.version).toBe(
      HANDOFF_STUDY_MATERIALS.alpha.files[0].current.version,
    );
    clock += 10 * 60 * 1000;
    expect(api.getStudyState().activeDrafts).toBe(0);
    await open(api);
    await expect(
      call(api, {
        action: "start",
        workspace_id: HANDOFF_STUDY_WORKSPACE.id,
        provider: "codex",
        draft_id: draftId,
      }),
    ).rejects.toThrow("已存在");
    const before = await preview(api);
    api.control("reset");
    expect(api.getStudyState()).toMatchObject({
      scenario: "initial",
      activeDrafts: 0,
      revision: 1,
    });
    await expect(prepare(api, before.digest)).rejects.toThrow("失效");
    await open(api);
    expect((await preview(api)).complete).toBe(true);
    expect(() => api.control("unlisted" as "reset")).toThrow("不存在");
  });

  test("cancel or control during digest prevents a late preview from reviving a draft", async () => {
    const api = createHandoffStudyApi("alpha");
    await open(api);
    await call(api, { action: "baseline", draft_id: draftId, paths: ["src/main.ts"] });
    const pending = call(api, {
      action: "preview",
      draft_id: draftId,
      fields: fields("alpha"),
      source_stopped: true,
      permissions_checked: true,
    });
    await call(api, { action: "cancel", draft_id: draftId });
    await expect(pending).rejects.toThrow("失效");
    await open(api);
    await call(api, { action: "baseline", draft_id: draftId, paths: ["src/main.ts"] });
    const edited = call(api, {
      action: "preview",
      draft_id: draftId,
      fields: fields("alpha"),
      source_stopped: true,
      permissions_checked: true,
    });
    api.control("edit-file");
    await expect(edited).rejects.toThrow("已改變");
  });

  test("Desktop lifecycle probe counts strict cancel after offline and uses the same complete-field API", async () => {
    const desktop = createDesktopHandoffApi();
    let probe: { activeDrafts: number; cancelCount: number; statusReads: number } | null = null;
    desktop.subscribe((next) => {
      probe = next;
    });
    const invoke = (input: unknown) => desktop.invoke("handoff_request", { input });
    await invoke({
      action: "start",
      workspace_id: HANDOFF_STUDY_WORKSPACE.id,
      provider: "manual",
      draft_id: draftId,
    });
    await invoke({ action: "baseline", draft_id: draftId, paths: ["README.md", "src/main.ts"] });
    const result = (await invoke({
      action: "preview",
      draft_id: draftId,
      fields: fields("alpha"),
      source_stopped: true,
      permissions_checked: true,
    })) as HandoffPreview;
    expect(result.text).toContain(HANDOFF_STUDY_MATERIALS.alpha.unknown);
    desktop.setMode("offline");
    await expect(
      invoke({
        action: "prepare",
        draft_id: draftId,
        content_digest: result.digest,
        source_stopped: true,
        permissions_checked: true,
      }),
    ).rejects.toThrow("無法核對");
    await expect(invoke({ action: "cancel", draft_id: draftId, extra: true })).rejects.toThrow(
      "格式",
    );
    await invoke({ action: "cancel", draft_id: draftId });
    await desktop.invoke("get_desktop_status");
    expect(probe).toMatchObject({ activeDrafts: 0, cancelCount: 1, statusReads: 1 });
  });
});
