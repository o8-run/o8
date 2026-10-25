// A named ESM boundary keeps lazy imports stable in the split server bundle.
// The CommonJS next/server entry otherwise exposes only a default export there.
export { NextRequest } from 'next/server';
