export function parseWorkbenchUrl(input: string): string {
  const value = input.trim();
  // Check raw authority first: URL canonicalization accepts integer/hex loopback aliases.
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/#session=[a-f0-9]{64}$/.test(value))
    throw new Error("請貼上完整的 http://127.0.0.1:連接埠/#session=… 工作台網址；不要貼審批網址。");
  const url = new URL(value);
  const port = Number(value.match(/:([0-9]+)\//)?.[1]);
  if (port > 65535 || port < 1 || url.username || url.password || url.search)
    throw new Error("工作台網址無效。");
  return value;
}

export function parsePairingUrl(input: string) {
  const value = input.trim();
  const match = value.match(
    /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/pair#code=([a-f0-9]{64})&instance=([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/,
  );
  if (!match || Number(match[1]) > 65535) throw new Error("請貼上 pair 指令產生的完整本機配對碼。");
  return {
    origin: new URL(value).origin,
    code: match[2] as string,
    instanceId: match[3] as string,
  };
}
