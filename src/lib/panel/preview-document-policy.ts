// A response sandbox keeps script-capable previews outside application authority.
// Next's configured headers must use the same policy as the route handlers.
export const PREVIEW_DOCUMENT_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads';
