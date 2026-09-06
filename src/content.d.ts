declare module "*.md" {
  const content: string;
  export default content;
}

declare module "*.css" {
  const content: string;
  export default content;
}

declare module "*copy-prompt.js" {
  const content: string;
  export default content;
}

declare module "*.woff2" {
  const content: string | ArrayBuffer;
  export default content;
}
