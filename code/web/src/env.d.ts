// esbuild bundles imported CSS into app.<hash>.css.
declare module '*.css';
// build.mjs defines these: this build's worker scripts (absolute paths with their content hashes; the Trusted Types
// policy in src/preview/tt.ts allows exactly these) and where its copy of pdf.js's fonts, CMaps and image decoders is.
declare const __BN_WORKERS__: { readonly csv: string; readonly data: string; readonly pdf: string };
declare const __BN_PDFJS_ASSETS__: string;
