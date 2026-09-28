export function validExtensionId(value: string | undefined): value is string {
  return typeof value === "string" && /^[a-p]{32}$/.test(value);
}
