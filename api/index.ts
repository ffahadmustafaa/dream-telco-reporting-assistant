// Vercel compiles this file as the /api serverless function. The real handler
// is pre-bundled by esbuild (see the build script in package.json) into
// ./_server.cjs, with everything under ../server inlined. Vercel's own file
// tracer does not follow imports outside api/, so importing ../server directly
// here ships a function that crashes with ERR_MODULE_NOT_FOUND at runtime.
// @ts-ignore - generated at build time, not present during typechecking
import bundle from "./_server.cjs";

const handler = (bundle as any)?.default || bundle;
export default handler;
