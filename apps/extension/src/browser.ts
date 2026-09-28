// Only the trusted extension page receives local pairing capabilities.
declare const chrome: {
  runtime: { id: string };
  sidePanel: { setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void> };
  permissions: {
    request(options: { origins: string[] }): Promise<boolean>;
    contains(options: { origins: string[] }): Promise<boolean>;
  };
  storage: {
    session: {
      get(key: string): Promise<Record<string, unknown>>;
      set(data: Record<string, unknown>): Promise<void>;
      remove(key: string): Promise<void>;
      setAccessLevel(options: { accessLevel: "TRUSTED_CONTEXTS" }): Promise<void>;
    };
  };
};
export const browser = chrome;
