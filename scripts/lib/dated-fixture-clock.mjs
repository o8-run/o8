const NativeDate = globalThis.Date;
const now = Number(process.env.O8_DATED_FIXTURE_NOW);
if (!Number.isSafeInteger(now) || now <= 0) throw new Error('A dated-fixture probe requires an explicit future clock');
const offset = now - NativeDate.now();

// Keep time advancing so durations and polling still work. Explicit dates and
// Vitest's own fake clocks retain their usual behavior.
function FutureDate(...args) {
  if (!new.target) return new NativeDate(NativeDate.now() + offset).toString();
  return Reflect.construct(NativeDate, args.length ? args : [NativeDate.now() + offset], new.target);
}
Object.setPrototypeOf(FutureDate, NativeDate);
FutureDate.prototype = NativeDate.prototype;
FutureDate.now = () => NativeDate.now() + offset;
globalThis.Date = FutureDate;
