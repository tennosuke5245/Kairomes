/** Only a current stream snapshot can establish the connection used by local controls. */
export class PanelStreamAvailability {
  private revision = 0;
  private ready = false;

  get generation() {
    return this.revision;
  }

  receivedSnapshot() {
    this.ready = true;
  }

  disconnected() {
    this.revision++;
    this.ready = false;
  }

  canRestore(readGeneration: number) {
    return this.ready && this.revision === readGeneration;
  }
}
