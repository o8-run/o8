// Give each no-argument construction a distinct millisecond within this fixture process.
const OriginalDate = Date;
let offset = 0;
globalThis.Date = class extends OriginalDate {
  constructor(...args) {
    if (args.length === 0) super(OriginalDate.now() + offset++);
    else super(...args);
  }
};
