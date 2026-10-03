/** Discard stale success and failure alike, including a read that invalidated pairing. */
export async function readMcpCatalog<T>(
  read: () => Promise<T>,
  current: () => boolean,
  receive: (state: T) => void,
  failure: (cause: unknown) => void,
) {
  try {
    const state = await read();
    if (current()) receive(state);
  } catch (cause) {
    if (current()) failure(cause);
  }
}
