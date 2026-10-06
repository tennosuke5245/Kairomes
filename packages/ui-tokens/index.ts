// CSS text for pages that inline one <style> block (preview fixtures, static daemon or
// CLI pages). Bun embeds text imports, so this also works inside `bun build --compile`.
// Browser surfaces link or bundle the .css files directly instead.
import componentsText from "./components.css" with { type: "text" };
import tokensText from "./tokens.css" with { type: "text" };

// String() because vite/client (Desktop) types every *.css import as an empty module.
export const tokensCss = String(tokensText);
export const componentsCss = String(componentsText);

/** Load order for surfaces that link or copy the files: tokens first, then components. */
export const UI_STYLESHEETS = ["tokens.css", "components.css"] as const;

/** tokens.css followed by components.css, ready to prepend to a surface stylesheet. */
export const uiCss = `${tokensCss}\n${componentsCss}`;
