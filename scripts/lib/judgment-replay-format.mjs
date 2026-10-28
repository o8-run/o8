export const fmt = (value, digits = 3) => (value === null || value === undefined ? 'n/a' : value.toFixed(digits));
