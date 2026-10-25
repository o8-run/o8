// Capture descriptors, not observed values: equal-looking clock mocks must
// still restore the functions, accessors and prototype links they replaced.
type Surface = {
  target: object;
  complete: boolean;
  prototype: object | null;
  descriptors: Map<PropertyKey, PropertyDescriptor | undefined>;
};

const descriptorFields = ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'] as const;
function sameDescriptor(a: PropertyDescriptor | undefined, b: PropertyDescriptor | undefined) {
  if (!a || !b) return a === b;
  return descriptorFields.every(key => Object.is(a[key], b[key]));
}

export function captureFixtureClock() {
  const date = globalThis.Date;
  const intl = globalThis.Intl;
  const performance = globalThis.performance;
  const surfaces: Surface[] = [];
  const capture = (target: object, keys?: PropertyKey[]) => {
    surfaces.push({ target, complete: !keys, prototype: Object.getPrototypeOf(target),
      descriptors: new Map((keys ?? Reflect.ownKeys(target))
        .map(key => [key, Object.getOwnPropertyDescriptor(target, key)])),
    });
  };
  capture(globalThis, ['Date', 'Intl', 'performance']);
  capture(intl, ['DateTimeFormat']);
  // Include constructor parents as well as instance prototypes. A mock may
  // reach the original Date/formatter through an inherited constructor.
  for (const constructor of [date, intl.DateTimeFormat]) {
    for (let target: object | null = constructor; target && target !== Function.prototype;
      target = Object.getPrototypeOf(target)) capture(target);
    for (let target: object | null = constructor.prototype; target && target !== Object.prototype;
      target = Object.getPrototypeOf(target)) capture(target);
  }
  for (let target: object | null = performance; target && target !== Object.prototype;
    target = Object.getPrototypeOf(target)) capture(target, ['timeOrigin']);

  return {
    matches() {
      return globalThis.Date === date && globalThis.Intl === intl && globalThis.performance === performance
        && surfaces.every(({ target, complete, prototype, descriptors }) => (
          Object.getPrototypeOf(target) === prototype
          && (!complete || Reflect.ownKeys(target).length === descriptors.size)
          && [...descriptors].every(([key, descriptor]) => (
            sameDescriptor(Object.getOwnPropertyDescriptor(target, key), descriptor)
          ))
        ));
    },
    restore() {
      // Restore roots first, then their captured objects, including an own
      // timeOrigin shadow or properties added to an existing prototype.
      for (const { target, complete, prototype, descriptors } of surfaces) {
        Object.setPrototypeOf(target, prototype);
        if (complete) for (const key of Reflect.ownKeys(target)) {
          if (!descriptors.has(key) && !Reflect.deleteProperty(target, key)) {
            throw new Error('Cannot restore a dated-fixture clock property');
          }
        }
        for (const [key, descriptor] of descriptors) {
          if (descriptor) Object.defineProperty(target, key, descriptor);
          else if (!Reflect.deleteProperty(target, key)) {
            throw new Error('Cannot restore a dated-fixture clock property');
          }
        }
      }
    },
  };
}
