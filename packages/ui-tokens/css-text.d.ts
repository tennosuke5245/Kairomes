// Bun text imports (`with { type: "text" }`) of the two token stylesheets. When Desktop's
// vite/client types are loaded, its broader '*.css' declaration takes precedence; index.ts
// coerces with String() so either typing works.
declare module "*/tokens.css" {
  const text: string;
  export default text;
}
declare module "*/components.css" {
  const text: string;
  export default text;
}
