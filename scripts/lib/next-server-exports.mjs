// Standalone handlers use these framework classes, not the rendering APIs in
// next/server's CommonJS barrel. Re-export the originals so middleware, cookies
// and instanceof checks keep the framework's semantics.
export { NextRequest } from 'next/dist/server/web/spec-extension/request.js';
export { NextResponse } from 'next/dist/server/web/spec-extension/response.js';
