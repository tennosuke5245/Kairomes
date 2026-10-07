// Path data for the few glyphs the vanilla MCP result card draws without React. The Phosphor
// paths are the regular weight of @phosphor-icons/react 2.1.10 (viewBox 0 0 256 256);
// icon-paths.test.tsx checks them against the installed package so they cannot drift.

/** The K mark (viewBox 0 0 128 128), the same shapes as app-icon.svg. */
export const K_MARK_PATHS = [
  "M22 16c-6 0-10 4-10 10v76c0 6 4 10 10 10s10-4 10-10V26c0-6-4-10-10-10Z",
  "M106 16H84c-3 0-6 1-8 4L38 57c-4 4-4 10 0 14l39 37c2 3 5 4 8 4h21c4 0 7-2 8-5 1-3 0-6-2-8L73 64l38-35c3-2 4-6 2-9-1-2-4-4-7-4Z",
] as const;

export const CARD_ICON_PATHS = {
  Check:
    "M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z",
  WarningCircle:
    "M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm-8-80V80a8,8,0,0,1,16,0v56a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,172Z",
  Info: "M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm16-40a8,8,0,0,1-8,8,16,16,0,0,1-16-16V128a8,8,0,0,1,0-16,16,16,0,0,1,16,16v40A8,8,0,0,1,144,176ZM112,84a12,12,0,1,1,12,12A12,12,0,0,1,112,84Z",
  CaretRight:
    "M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z",
  CaretDown:
    "M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z",
  Copy: "M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z",
} as const;

export type CardIcon = keyof typeof CARD_ICON_PATHS;
