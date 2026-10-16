// esbuild bundles imported CSS into app.<hash>.css.
declare module '*.css';
// build.mjs defines these: this build's worker scripts (absolute paths with their content hashes; the Trusted Types
// policy in src/preview/tt.ts allows exactly these) and where its copy of pdf.js's fonts, CMaps and image decoders is.
declare const __BN_WORKERS__: { readonly csv: string; readonly data: string; readonly pdf: string; readonly docx: string; readonly sheet: string; readonly deck: string };
declare const __BN_PDFJS_ASSETS__: string;
// KaTeX's stylesheet (its fonts next to it), loaded with the first formula; the artifact viewer's pages (served on
// the sandboxed artifact site, never on the code host: src/preview/artifact.ts).
declare const __BN_KATEX_CSS__: string;
declare const __BN_ARTIFACT__: { readonly html: string; readonly mermaid: string };
