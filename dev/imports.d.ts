// Static UI assets are bundled as text modules by the Text rule in
// wrangler.dev.jsonc (html, css, and *.client.js — never plain *.js, which would
// swallow real JavaScript imports).
declare module "*.html" {
  const content: string;
  export default content;
}

declare module "*.css" {
  const content: string;
  export default content;
}

declare module "*.client.js" {
  const content: string;
  export default content;
}
