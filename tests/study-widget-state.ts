export type StudyWidgetState = {
  revision: number;
  fileChanged: boolean;
  imageChanged: boolean;
  eventCount: number;
  readFailure: number;
  unmounted: boolean;
};

const keys = ["revision", "fileChanged", "imageChanged", "eventCount", "readFailure", "unmounted"];
const initial = (value: StudyWidgetState) =>
  !value.fileChanged &&
  !value.imageChanged &&
  !value.eventCount &&
  !value.readFailure &&
  !value.unmounted;

/** Only finite study state is accepted; operator data cannot become a tool or host instruction. */
export class StudyWidgetController {
  private previous: StudyWidgetState | undefined;
  private failures = 0;

  receive(input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    const value = input as Record<string, unknown>;
    if (
      Object.keys(value).length !== keys.length ||
      Object.keys(value).some((key) => !keys.includes(key))
    )
      return;
    for (const key of ["revision", "eventCount", "readFailure"])
      if (typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) || value[key] < 0)
        return;
    for (const key of ["fileChanged", "imageChanged", "unmounted"])
      if (typeof value[key] !== "boolean") return;
    const state = value as StudyWidgetState;
    const previous = this.previous;
    if (previous && state.revision <= previous.revision) return;
    const reset = !!previous && initial(state);
    if (
      previous &&
      !reset &&
      (state.eventCount < previous.eventCount ||
        state.readFailure < previous.readFailure ||
        (previous.fileChanged && !state.fileChanged) ||
        (previous.imageChanged && !state.imageChanged) ||
        (previous.unmounted && !state.unmounted))
    )
      return;
    // Initial values are a baseline, so reload cannot replay a consumed failure/event.
    if (reset) this.failures = 0;
    else if (previous) this.failures += state.readFailure - previous.readFailure;
    this.previous = { ...state };
    return {
      state: this.previous,
      reset,
      events: previous && !reset ? state.eventCount - previous.eventCount : 0,
    };
  }

  consumeFailure() {
    if (!this.failures) return false;
    this.failures--;
    return true;
  }
}
