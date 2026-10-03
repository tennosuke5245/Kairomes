export type StudyMaterialId = "alpha" | "beta";
export type StudyFileVersion = Readonly<{ content: string; version: string; bytes: number }>;
export type StudyMaterial = Readonly<{
  id: StudyMaterialId;
  title: string;
  sessionId: string;
  goal: string;
  completed: readonly [string, string];
  unknown: string;
  nextAction: string;
  files: readonly [
    Readonly<{
      path: string;
      historical: StudyFileVersion;
      current: StudyFileVersion;
      edited: StudyFileVersion;
    }>,
    Readonly<{ path: string; historical: StudyFileVersion; current: StudyFileVersion }>,
  ];
}>;

export const HANDOFF_STUDY_WORKSPACE = Object.freeze({
  id: "00000000-0000-4000-8000-000000000010",
  name: "接續測試專案",
  capabilities: Object.freeze(["read", "write_request"]),
});

function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

/** Fixed public synthetic evidence. Versions are SHA-256 of the exact UTF-8 content below. */
export const HANDOFF_STUDY_MATERIALS: Readonly<Record<StudyMaterialId, StudyMaterial>> = immutable({
  alpha: {
    id: "alpha",
    title: "待處理列表調整",
    sessionId: "study-alpha-session",
    goal: "讓待處理列表辨認到期項目，返回時保留原選擇。",
    completed: ["新增到期標記。", "返回列表後保留選擇。"],
    unknown: "鍵盤 Esc 返回尚未試用。",
    nextAction: "核對兩個相關檔案後，試用鍵盤 Esc 返回。",
    files: [
      {
        path: "src/main.ts",
        historical: {
          content: 'export const requestLabel = (expired: boolean) => "待確認";\n',
          version: "b959a8e36ac1299a33e8bd7449ee6c71669a40bfa53fe2e18e72f621117f42e9",
          bytes: 63,
        },
        current: {
          content:
            'export const requestLabel = (expired: boolean) => expired ? "已到期" : "待確認";\n',
          version: "198bd64fc4ded48f267282bb2a092f65a95170640a3562f1a89f9c6b8d25b750",
          bytes: 87,
        },
        edited: {
          content:
            'export const requestLabel = (expired: boolean) => expired ? "到期" : "待確認";\n',
          version: "eade1cb933f12cce9f6a02e982b49649ce4eef88cce6d31d4603f135a22d4390",
          bytes: 84,
        },
      },
      {
        path: "README.md",
        historical: {
          content: '// 合成試用材料，沒有執行測試。\nexport const selectedRequest = "sample-a";\n',
          version: "6a99cfe86640d68779d769586c8faecff14bf87d638378bd49a0691b7687b777",
          bytes: 89,
        },
        current: {
          content: '// 合成試用材料，沒有執行測試。\nexport const selectedRequest = "sample-a";\n',
          version: "6a99cfe86640d68779d769586c8faecff14bf87d638378bd49a0691b7687b777",
          bytes: 89,
        },
      },
    ],
  },
  beta: {
    id: "beta",
    title: "搜尋狀態調整",
    sessionId: "study-beta-session",
    goal: "讓搜尋頁區分沒有結果與連線錯誤，重試時保留查詢。",
    completed: ["空白結果與連線錯誤分開顯示。", "重試時保留原查詢。"],
    unknown: "重連後焦點位置尚未試用。",
    nextAction: "核對兩個相關檔案後，試用重連時的焦點返回。",
    files: [
      {
        path: "src/main.ts",
        historical: {
          content: 'export const searchLabel = (failed: boolean) => "沒有結果";\n',
          version: "18c6f41e8aee226489fc1a310d8680075577367cd022875795d0bdfd8ff55325",
          bytes: 64,
        },
        current: {
          content:
            'export const searchLabel = (failed: boolean) => failed ? "連線錯誤" : "沒有結果";\n',
          version: "f68acfeb0583ac57fe687d6c37fe3ea907c4a197dd24b58a16964df5ef87929c",
          bytes: 90,
        },
        edited: {
          content:
            'export const searchLabel = (failed: boolean) => failed ? "暫時離線" : "沒有結果";\n',
          version: "9d9615901a8cc50155b4583a9274b14b60d9beadf0be17ccac55edf8c0acea85",
          bytes: 90,
        },
      },
      {
        path: "README.md",
        historical: {
          content: '// 合成試用材料，沒有執行測試。\nexport const retainedQuery = "sample-b";\n',
          version: "4ff3779f61607e37d3491e07e683cc64ae5f24c2647dd6f9cba9540d1c956c4c",
          bytes: 87,
        },
        current: {
          content: '// 合成試用材料，沒有執行測試。\nexport const retainedQuery = "sample-b";\n',
          version: "4ff3779f61607e37d3491e07e683cc64ae5f24c2647dd6f9cba9540d1c956c4c",
          bytes: 87,
        },
      },
    ],
  },
});

export function studyMaterialId(value: unknown): StudyMaterialId {
  if (value !== "alpha" && value !== "beta") throw new Error("合成材料不存在。");
  return value;
}

/** Both trial methods see this same evidence; no score, controls or filled participant fields. */
export function renderStudyMaterial(id: StudyMaterialId): string {
  const material = HANDOFF_STUDY_MATERIALS[studyMaterialId(id)];
  return [
    `合成來源：${material.title}`,
    `目標：${material.goal}`,
    `已完成：\n${material.completed.join("\n")}`,
    `未驗：${material.unknown}`,
    `下一步：${material.nextAction}`,
    "歷史檢查時間：未知；以下材料未執行真實測試。",
    ...material.files.flatMap((file) => [
      `\n相關檔案：${file.path}`,
      `歷史版本：${file.historical.version}（${file.historical.bytes} bytes）`,
      file.historical.content.trimEnd(),
      ...(file.current.version === file.historical.version
        ? ["目前內容與歷史版本相同。"]
        : [
            `目前版本：${file.current.version}（${file.current.bytes} bytes）`,
            file.current.content.trimEnd(),
          ]),
    ]),
  ].join("\n");
}
