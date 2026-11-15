/** Maximum decoded artifact size, shared by ingest and its native registration. */
export const ARTIFACT_MAX_BYTES = 25 * 1024 * 1024;
// Base64 expands bytes by 4/3; reserve 64 KiB for JSON metadata or multipart framing.
export const ARTIFACT_REQUEST_MAX_BYTES = 4 * Math.ceil(ARTIFACT_MAX_BYTES / 3) + 64 * 1024;
