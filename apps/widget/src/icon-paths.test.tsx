import { expect, test } from "bun:test";
import {
  CaretDownIcon,
  CaretRightIcon,
  CheckIcon,
  CopyIcon,
  type Icon,
  InfoIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { renderToStaticMarkup } from "react-dom/server";
import { CARD_ICON_PATHS, type CardIcon, K_MARK_PATHS } from "./icon-paths.ts";
import { KMark } from "./ui-icons.tsx";

const phosphor: Record<CardIcon, Icon> = {
  Check: CheckIcon,
  WarningCircle: WarningCircleIcon,
  Info: InfoIcon,
  CaretRight: CaretRightIcon,
  CaretDown: CaretDownIcon,
  Copy: CopyIcon,
};
const paths = (markup: string) => [...markup.matchAll(/ d="([^"]+)"/g)].map((match) => match[1]);

test("the result card's glyphs are the installed Phosphor regular paths", () => {
  for (const [name, Glyph] of Object.entries(phosphor) as [CardIcon, Icon][])
    expect(paths(renderToStaticMarkup(<Glyph />)), name).toEqual([CARD_ICON_PATHS[name]]);
});

test("the React K mark and the vanilla card share one set of paths", () => {
  expect(paths(renderToStaticMarkup(<KMark />))).toEqual([...K_MARK_PATHS]);
});
