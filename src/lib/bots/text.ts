/** Keep a UTF-16 prefix without splitting a well-formed surrogate pair. */
export function botTextPrefix(value: string, maxUnits: number): string {
  let end = maxUnits;
  const before = value.charCodeAt(end - 1);
  const after = value.charCodeAt(end);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end -= 1;
  return value.slice(0, end);
}
