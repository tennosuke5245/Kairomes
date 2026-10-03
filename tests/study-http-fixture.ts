import { createHandoffStudyApi } from "./handoff-study-api.ts";
import type { StudyWidgetState } from "./study-widget-state.ts";

/** Finite synthetic controls only. No process, file, credential or host operations. */
export function createStudyHttpFixture() {
  const handoffs = {
    alpha: createHandoffStudyApi("alpha"),
    beta: createHandoffStudyApi("beta"),
  };
  const widget: StudyWidgetState = {
    revision: 0,
    fileChanged: false,
    imageChanged: false,
    eventCount: 0,
    readFailure: 0,
    unmounted: false,
  };
  const probe = () => ({
    widget: { ...widget },
    alpha: handoffs.alpha.getStudyState(),
    beta: handoffs.beta.getStudyState(),
  });
  const reply = (data: unknown, status = 200) =>
    Response.json(data, {
      status,
      headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
    });
  return {
    probe,
    async handle(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/synthetic-study/")) return null;
      if (request.method === "GET") {
        if (url.pathname === "/synthetic-study/widget-state") return reply({ ...widget });
        if (url.pathname === "/synthetic-study/probe") return reply(probe());
        return reply({}, 404);
      }
      if (request.method !== "POST" || request.headers.get("origin") !== url.origin)
        return reply({ message: "Synthetic origin rejected" }, 403);
      let body: Record<string, unknown>;
      try {
        const text = await request.text();
        if (new TextEncoder().encode(text).length > 4096) throw new Error("Body too large");
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("Invalid body");
        body = parsed as Record<string, unknown>;
      } catch {
        return reply({ message: "Invalid body" }, 400);
      }
      const keys = Object.keys(body).sort().join(",");
      if (url.pathname === "/synthetic-study/handoff") {
        if (
          keys !== "command,input,material" ||
          body.command !== "handoff_request" ||
          (body.material !== "alpha" && body.material !== "beta")
        )
          return reply({}, 400);
        try {
          return reply(await handoffs[body.material].request("handoff_request", body.input));
        } catch (cause) {
          return reply({ message: cause instanceof Error ? cause.message : "合成請求失敗" }, 409);
        }
      }
      if (url.pathname !== "/synthetic-study/control") return reply({}, 404);
      if (keys !== "action,material" || typeof body.action !== "string") return reply({}, 400);
      if (body.material === "alpha" || body.material === "beta") {
        if (!["edit-file", "source-pending", "missing-file", "reset"].includes(body.action))
          return reply({}, 400);
        const action = body.action as "edit-file" | "source-pending" | "missing-file" | "reset";
        return reply(handoffs[body.material].control(action));
      }
      if (body.material !== "widget") return reply({}, 400);
      switch (body.action) {
        case "edit-file":
          widget.fileChanged = true;
          break;
        case "edit-image":
          widget.imageChanged = true;
          break;
        case "new-event":
          widget.eventCount++;
          break;
        case "fail-read":
          widget.readFailure++;
          break;
        case "unmount":
          widget.unmounted = true;
          break;
        case "reset":
          widget.fileChanged = widget.imageChanged = widget.unmounted = false;
          widget.eventCount = widget.readFailure = 0;
          break;
        default:
          return reply({}, 400);
      }
      widget.revision++;
      return reply({ ...widget });
    },
  };
}
