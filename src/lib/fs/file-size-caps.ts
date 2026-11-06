const DEFAULT_FILE_EDIT_MAX_BYTES = 128 * 1024 * 1024;
const override = Number(process.env.O8_FILE_EDIT_MAX_BYTES);

/**
 * The largest file the editors open for editing, in bytes. It matches the
 * native editor's read-only threshold (`READ_ONLY_BYTES` in
 * native/o8-next/src/files_panel/source.rs): larger files open read-only.
 *
 * Previews read at most this many bytes and report `truncated` above it, so a
 * preview's memory stays bounded. Editing reads refuse above it instead, since
 * saving a truncated read would cut the file.
 *
 * Test fixtures may lower it with `O8_FILE_EDIT_MAX_BYTES` to exercise
 * truncation without writing 128 MiB; the override can never raise it.
 */
export const FILE_EDIT_MAX_BYTES = Number.isSafeInteger(override) && override > 0 && override < DEFAULT_FILE_EDIT_MAX_BYTES
  ? override
  : DEFAULT_FILE_EDIT_MAX_BYTES;
