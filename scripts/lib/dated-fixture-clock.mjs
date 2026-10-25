const NativeDate = globalThis.Date;
const nativeNow = NativeDate.now.bind(NativeDate);
const now = Number(process.env.O8_DATED_FIXTURE_NOW);
if (!Number.isSafeInteger(now) || now <= 0) throw new Error('A dated-fixture probe requires an explicit future clock');
const offset = now - nativeNow();
const futureNow = () => nativeNow() + offset;

// Keep time advancing so durations and polling still work. Explicit dates and
// Vitest's own fake clocks retain their usual behavior. Copy native statics
// rather than exposing the unshifted native constructor as Date's parent.
function FutureDate(...args) {
  if (!new.target) return new NativeDate(futureNow()).toString();
  return Reflect.construct(NativeDate, args.length ? args : [futureNow()], new.target);
}
Object.defineProperties(FutureDate, { ...Object.getOwnPropertyDescriptors(NativeDate),
  now: { ...Object.getOwnPropertyDescriptor(NativeDate, 'now'), value: futureNow },
});
Object.defineProperty(NativeDate.prototype, 'constructor', {
  ...Object.getOwnPropertyDescriptor(NativeDate.prototype, 'constructor'), value: FutureDate,
});
globalThis.Date = FutureDate;

// Intl's omitted date uses its own wall clock, independently of Date.now.
// Shift that native default too, preserving explicit values and bound identity.
const formatter = Intl.DateTimeFormat.prototype;
const format = Object.getOwnPropertyDescriptor(formatter, 'format');
const boundFormats = new WeakMap();
Object.defineProperty(formatter, 'format', { ...format, get() {
  const nativeFormat = Reflect.apply(format.get, this, []);
  let bound = boundFormats.get(this);
  if (!bound) {
    bound = value => nativeFormat(value === undefined ? futureNow() : value);
    boundFormats.set(this, bound);
  }
  return bound;
} });
const parts = Object.getOwnPropertyDescriptor(formatter, 'formatToParts');
Object.defineProperty(formatter, 'formatToParts', { ...parts, value(value) {
  return Reflect.apply(parts.value, this, [value === undefined ? futureNow() : value]);
} });

// Shift the epoch origin, including node:perf_hooks aliases; leave monotonic
// performance.now and duration arithmetic unchanged.
let originOwner = performance;
while (originOwner && !Object.hasOwn(originOwner, 'timeOrigin')) originOwner = Object.getPrototypeOf(originOwner);
if (!originOwner) throw new Error('The dated-fixture probe requires performance.timeOrigin');
const origin = Object.getOwnPropertyDescriptor(originOwner, 'timeOrigin');
Object.defineProperty(originOwner, 'timeOrigin', { ...origin, get() {
  return Reflect.apply(origin.get, this, []) + offset;
} });
