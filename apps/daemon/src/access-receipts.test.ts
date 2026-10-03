import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  KairomesError,
  PANEL_ACCESS_LIMITS,
  PanelAccessMutationSchema,
  panelAccessFingerprint,
  panelAccessIdentity,
  type TrackedPanelAccessMutation,
} from "@kairomes/protocol";
import { AccessReceipts } from "./access-receipts.ts";

const workspace = "00000000-0000-4000-8000-000000000010";
const otherWorkspace = "00000000-0000-4000-8000-000000000011";
const token = "synthetic-owner-a";
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}
function enable(now = 1000, id = crypto.randomUUID()): TrackedPanelAccessMutation {
  return {
    action: "enable",
    workspace_id: workspace,
    level: "files",
    minutes: null,
    request_id: id,
    valid_until: now + 10_000,
  };
}
function fingerprint(input: TrackedPanelAccessMutation) {
  return createHash("sha256").update(panelAccessIdentity(input)).digest("hex");
}
function recover(prior: TrackedPanelAccessMutation, now = 1000): TrackedPanelAccessMutation {
  return {
    action: "disable",
    workspace_id: prior.workspace_id,
    request_id: crypto.randomUUID(),
    valid_until: now + 10_000,
    supersedes: {
      request_id: prior.request_id,
      valid_until: prior.valid_until,
      fingerprint: fingerprint(prior),
    },
  };
}

test("receipt exact normalized ID/body returns pending or completed without replaying side effects", async () => {
  const receipts = new AccessReceipts(
    () => true,
    () => 1000,
  );
  const held = deferred();
  const input = enable();
  let effects = 0;
  const executing = receipts.run(token, input, async () => {
    effects++;
    await held.promise;
  });
  try {
    const repeated = await receipts.run(token, { ...input }, async () => {
      effects++;
    });
    expect(repeated).toMatchObject({
      request_id: input.request_id,
      state: "pending",
      fingerprint: fingerprint(input),
    });
    expect(repeated.fingerprint).toBe(await panelAccessFingerprint(input));
    repeated.state = "completed";
    expect(receipts.status(token, input.request_id).state).toBe("pending");
    held.resolve();
    const completed = await executing;
    expect(completed.state).toBe("completed");
    expect(
      await receipts.run(token, { ...input }, async () => {
        effects++;
      }),
    ).toEqual(completed);
    expect(effects).toBe(1);
  } finally {
    held.resolve();
    await executing;
    receipts.close();
  }
});

test("receipt identity binds normalized defaults, action, workspace, level, duration and original deadline", async () => {
  const receipts = new AccessReceipts(
    () => true,
    () => 1000,
  );
  const implicit = PanelAccessMutationSchema.parse({
    action: "enable",
    workspace_id: workspace,
    request_id: crypto.randomUUID(),
    valid_until: 11_000,
  }) as TrackedPanelAccessMutation;
  const explicit = PanelAccessMutationSchema.parse({
    ...implicit,
    level: "full",
    minutes: 60,
  }) as TrackedPanelAccessMutation;
  let effects = 0;
  const execute = async () => {
    effects++;
  };
  try {
    await receipts.run(token, implicit, execute);
    expect((await receipts.run(token, explicit, execute)).state).toBe("completed");
    const changed = [
      { ...explicit, workspace_id: otherWorkspace },
      { ...explicit, action: "disable", level: undefined, minutes: undefined },
      { ...explicit, level: "files" },
      { ...explicit, minutes: 15 },
      { ...explicit, valid_until: 12_000 },
    ];
    for (const value of changed)
      await expect(
        receipts.run(token, value as TrackedPanelAccessMutation, execute),
      ).rejects.toMatchObject({ code: "ACCESS_REQUEST_CHANGED" });
    expect(effects).toBe(1);
  } finally {
    receipts.close();
  }
});

test("receipt source ownership isolates identical request IDs and fences only the same owner", async () => {
  const owners = new Set([token, "synthetic-owner-b"]);
  const receipts = new AccessReceipts(
    (owner) => owners.has(owner),
    () => 1000,
  );
  const input = enable();
  let validA = () => false;
  let validB = () => false;
  let effects = 0;
  try {
    await receipts.run(token, input, async (valid) => {
      validA = valid;
      effects++;
    });
    expect(receipts.status("synthetic-owner-b", input.request_id)).toMatchObject({
      state: "missing",
      fingerprint: null,
    });
    await receipts.run("synthetic-owner-b", input, async (valid) => {
      validB = valid;
      effects++;
    });
    await receipts.run(token, recover(input), async () => {
      effects++;
    });
    expect(validA()).toBe(false);
    expect(validB()).toBe(true);
    expect(receipts.status(token, input.request_id).state).toBe("superseded");
    expect(receipts.status("synthetic-owner-b", input.request_id).state).toBe("completed");
    expect(receipts.status("unrelated-owner", input.request_id)).toMatchObject({
      state: "missing",
      fingerprint: null,
    });
    await expect(
      receipts.run("unrelated-owner", input, async () => {
        effects++;
      }),
    ).rejects.toMatchObject({ code: "ACCESS_INVALID" });
    expect(effects).toBe(3);
  } finally {
    receipts.close();
  }
});

test("receipt deadline bounds admission without expiring an already accepted operation or grant predicate", async () => {
  let clock = 1000;
  const receipts = new AccessReceipts(
    () => true,
    () => clock,
  );
  const held = deferred();
  const input = { ...enable(), valid_until: 1001 };
  let valid = () => false;
  let effects = 0;
  const pending = receipts.run(token, input, async (check) => {
    valid = check;
    effects++;
    await held.promise;
  });
  try {
    clock = 1001 + PANEL_ACCESS_LIMITS.receiptMs;
    expect(valid()).toBe(true);
    expect(receipts.status(token, input.request_id).state).toBe("pending");
    await expect(
      receipts.run(token, { ...enable(clock), valid_until: clock }, async () => {
        effects++;
      }),
    ).rejects.toMatchObject({ code: "ACCESS_REQUEST_EXPIRED" });
    await expect(
      receipts.run(
        token,
        { ...enable(clock), valid_until: clock + PANEL_ACCESS_LIMITS.intentMs + 1 },
        async () => {
          effects++;
        },
      ),
    ).rejects.toMatchObject({ code: "ACCESS_REQUEST_EXPIRED" });
    held.resolve();
    expect((await pending).state).toBe("completed");
    expect(
      (
        await receipts.run(token, input, async () => {
          effects++;
        })
      ).state,
    ).toBe("completed");
    expect(effects).toBe(1);
  } finally {
    held.resolve();
    await pending;
    receipts.close();
  }
});

test("expired rich receipts and missing IDs stay distinct from completed and never re-execute retired identities", async () => {
  let clock = 1000;
  const receipts = new AccessReceipts(
    () => true,
    () => clock,
    { ...PANEL_ACCESS_LIMITS, receipts: 1 },
  );
  let effects = 0;
  const execute = async () => {
    effects++;
  };
  const first = enable(clock);
  const second = enable(clock);
  try {
    expect(receipts.status(token, first.request_id)).toMatchObject({
      state: "missing",
      fingerprint: null,
    });
    await receipts.run(token, first, execute);
    clock++;
    await receipts.run(token, second, execute);
    expect(receipts.status(token, first.request_id)).toMatchObject({
      state: "expired",
      fingerprint: fingerprint(first),
    });
    expect((await receipts.run(token, first, execute)).state).toBe("expired");
    clock += PANEL_ACCESS_LIMITS.receiptMs;
    expect(receipts.status(token, second.request_id).state).toBe("expired");
    expect((await receipts.run(token, second, execute)).state).toBe("expired");
    expect(receipts.status(token, crypto.randomUUID()).state).toBe("missing");
    expect(effects).toBe(2);
  } finally {
    receipts.close();
  }
});

test("failed execute is a settled receipt, not a claim that earlier side effects never occurred", async () => {
  const receipts = new AccessReceipts(
    () => true,
    () => 1000,
  );
  const input = enable();
  let effects = 0;
  try {
    const failed = await receipts.run(token, input, async () => {
      effects++;
      throw new KairomesError("SYNTHETIC_CLEANUP", "合成清理尚未完成。");
    });
    expect(failed).toMatchObject({ state: "failed", message: "合成清理尚未完成。" });
    expect(
      (
        await receipts.run(token, input, async () => {
          effects++;
        })
      ).state,
    ).toBe("failed");
    expect(effects).toBe(1);
  } finally {
    receipts.close();
  }
});

test("recovery fences a delayed original body before execute and exact recovery retry does not revoke twice", async () => {
  const receipts = new AccessReceipts(
    () => true,
    () => 1000,
  );
  const original = enable();
  const recovery = recover(original);
  let enables = 0;
  let revokes = 0;
  try {
    const result = await receipts.run(token, recovery, async () => {
      revokes++;
      expect(receipts.status(token, original.request_id).state).toBe("superseded");
    });
    expect(result.state).toBe("completed");
    expect(
      (
        await receipts.run(token, original, async () => {
          enables++;
        })
      ).state,
    ).toBe("superseded");
    expect(
      await receipts.run(token, recovery, async () => {
        revokes++;
      }),
    ).toEqual(result);
    expect(enables).toBe(0);
    expect(revokes).toBe(1);
    await expect(
      receipts.run(token, { ...original, valid_until: original.valid_until + 1 }, async () => {
        enables++;
      }),
    ).rejects.toMatchObject({ code: "ACCESS_REQUEST_CHANGED" });
  } finally {
    receipts.close();
  }
});

test("recovery must match prior workspace, fingerprint and deadline before fencing any grant predicate", async () => {
  const receipts = new AccessReceipts(
    () => true,
    () => 1000,
  );
  const input = enable();
  const held = deferred();
  let valid = () => false;
  let revokes = 0;
  const pending = receipts.run(token, input, async (check) => {
    valid = check;
    await held.promise;
  });
  const recovery = recover(input);
  if (recovery.action !== "disable" || !recovery.supersedes)
    throw new Error("Expected synthetic recovery");
  try {
    for (const changed of [
      { ...recovery, workspace_id: otherWorkspace },
      { ...recovery, supersedes: { ...recovery.supersedes, fingerprint: "0".repeat(64) } },
      { ...recovery, supersedes: { ...recovery.supersedes, valid_until: input.valid_until + 1 } },
    ]) {
      await expect(
        receipts.run(token, changed, async () => {
          revokes++;
        }),
      ).rejects.toMatchObject({ code: "ACCESS_REQUEST_CHANGED" });
      expect(valid()).toBe(true);
      expect(receipts.status(token, input.request_id).state).toBe("pending");
    }
    await receipts.run(token, recovery, async () => {
      revokes++;
      expect(valid()).toBe(false);
    });
    await expect(
      receipts.run(token, recover(input), async () => {
        revokes++;
      }),
    ).rejects.toMatchObject({ code: "ACCESS_REQUEST_CHANGED" });
    expect(revokes).toBe(1);
    held.resolve();
    expect((await pending).state).toBe("superseded");
  } finally {
    held.resolve();
    await pending;
    receipts.close();
  }
});

test("superseded primary awaits retain in-flight capacity and observe an invalid predicate when they resume", async () => {
  let clock = 1000;
  const receipts = new AccessReceipts(
    () => true,
    () => clock,
  );
  const held = Array.from({ length: 4 }, () => deferred());
  const inputs = Array.from({ length: 4 }, () => enable(clock));
  const resumed: boolean[] = [];
  let effects = 0;
  const pending = inputs.map((input, index) =>
    receipts.run(token, input, async (valid) => {
      effects++;
      await held[index]?.promise;
      resumed.push(valid());
    }),
  );
  try {
    for (const input of inputs) await receipts.run(token, recover(input), async () => {});
    expect(inputs.map((input) => receipts.status(token, input.request_id).state)).toEqual(
      Array(4).fill("superseded"),
    );
    clock += PANEL_ACCESS_LIMITS.receiptMs;
    for (const input of inputs)
      expect(receipts.status(token, input.request_id).state).toBe("superseded");
    await expect(
      receipts.run(token, enable(clock), async () => {
        effects++;
      }),
    ).rejects.toMatchObject({ code: "ACCESS_RECEIPT_LIMIT" });
    expect(effects).toBe(4);
    held[0]?.resolve();
    expect((await pending[0])?.state).toBe("superseded");
    expect(
      (
        await receipts.run(token, enable(clock), async () => {
          effects++;
        })
      ).state,
    ).toBe("completed");
    for (const wait of held) wait.resolve();
    await Promise.all(pending);
    expect(resumed).toEqual([false, false, false, false]);
  } finally {
    for (const wait of held) wait.resolve();
    await Promise.all(pending);
    receipts.close();
  }
});

test("recovery in-flight capacity rejects before creating another missing-prior fence", async () => {
  const receipts = new AccessReceipts(
    () => true,
    () => 1000,
  );
  const held = Array.from({ length: 4 }, () => deferred());
  const recoveries = Array.from({ length: 4 }, () => recover(enable()));
  const pending = recoveries.map((input, index) =>
    receipts.run(token, input, async () => {
      await held[index]?.promise;
    }),
  );
  const original = enable();
  let effects = 0;
  try {
    await expect(
      receipts.run(token, recover(original), async () => {
        effects++;
      }),
    ).rejects.toMatchObject({ code: "ACCESS_RECEIPT_LIMIT" });
    expect(receipts.status(token, original.request_id).state).toBe("missing");
    expect(effects).toBe(0);
    held[0]?.resolve();
    await pending[0];
    expect(
      (
        await receipts.run(token, recover(original), async () => {
          effects++;
        })
      ).state,
    ).toBe("completed");
    expect(effects).toBe(1);
  } finally {
    for (const wait of held) wait.resolve();
    await Promise.all(pending);
    receipts.close();
  }
});

test("missing-prior tombstones cannot consume recovery reservations for accepted enables near the real 256-ID ledger limit", async () => {
  const receipts = new AccessReceipts(
    () => true,
    () => 1000,
  );
  const accepted: TrackedPanelAccessMutation[] = [];
  let grants = 0;
  let revokes = 0;
  try {
    for (let index = 0; index < 2; index++)
      await receipts.run(token, recover(enable()), async () => {
        revokes++;
      });
    // Four tombstone/recovery IDs leave 126 pairs of primary + guaranteed recovery.
    for (let index = 0; index < 126; index++) {
      const input = enable();
      accepted.push(input);
      expect(
        (
          await receipts.run(token, input, async () => {
            grants++;
          })
        ).state,
      ).toBe("completed");
    }
    await expect(
      receipts.run(token, enable(), async () => {
        grants++;
      }),
    ).rejects.toMatchObject({ code: "ACCESS_RECEIPT_LIMIT" });
    const absent = enable();
    await expect(
      receipts.run(token, recover(absent), async () => {
        revokes++;
      }),
    ).rejects.toMatchObject({ code: "ACCESS_RECEIPT_LIMIT" });
    expect(receipts.status(token, absent.request_id).state).toBe("missing");
    for (const input of accepted)
      expect(
        (
          await receipts.run(token, recover(input), async () => {
            revokes++;
          })
        ).state,
      ).toBe("completed");
    expect(grants).toBe(126);
    expect(revokes).toBe(128);
    expect(receipts.status(token, accepted[0]?.request_id ?? "").state).not.toBe("pending");
  } finally {
    receipts.close();
  }
});

test("owner capacity remains bounded and a rejected owner cannot execute or read another owner's receipt", async () => {
  const receipts = new AccessReceipts(
    () => true,
    () => 1000,
  );
  const first = enable();
  let effects = 0;
  try {
    for (let index = 0; index < PANEL_ACCESS_LIMITS.owners; index++)
      await receipts.run(`synthetic-owner-${index}`, first, async () => {
        effects++;
      });
    await expect(
      receipts.run("synthetic-owner-overflow", first, async () => {
        effects++;
      }),
    ).rejects.toMatchObject({ code: "ACCESS_RECEIPT_LIMIT" });
    expect(receipts.status("synthetic-owner-overflow", first.request_id)).toMatchObject({
      state: "missing",
      fingerprint: null,
    });
    expect(effects).toBe(PANEL_ACCESS_LIMITS.owners);
  } finally {
    receipts.close();
  }
});

test("owner revoke, expiry and close invalidate captured predicates and never restore retired entries", async () => {
  for (const action of ["revoke", "expire", "close"] as const) {
    let live = true;
    const receipts = new AccessReceipts(
      () => live,
      () => 1000,
    );
    const input = enable();
    const held = deferred();
    let valid = () => false;
    const pending = receipts.run(token, input, async (check) => {
      valid = check;
      await held.promise;
    });
    try {
      expect(valid()).toBe(true);
      if (action === "revoke") {
        live = false;
        receipts.revoke(token);
      } else if (action === "expire") live = false;
      else receipts.close();
      expect(valid()).toBe(false);
      expect(receipts.status(token, input.request_id)).toMatchObject({
        state: "missing",
        fingerprint: null,
      });
      held.resolve();
      expect((await pending).state).not.toBe("completed");
      expect(receipts.status(token, input.request_id).state).toBe("missing");
    } finally {
      held.resolve();
      await pending;
      receipts.close();
    }
  }
});
