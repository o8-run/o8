/** Messages in this error are safe to return through operator surfaces. */
export class ExternalReviewError extends Error {
  constructor(message: string, readonly status: 400 | 409 | 502) { super(message); }
}
