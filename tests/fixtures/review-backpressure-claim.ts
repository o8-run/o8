// A separate coordinator process against the caller's temporary SQLite store.
import { claimNextReview } from '../../src/lib/lane/review-drain-recovery';
import { closeDb } from '../../src/lib/db';
const claim = claimNextReview();
process.stdout.write(`CLAIM:${JSON.stringify(claim)}\n`);
closeDb();
