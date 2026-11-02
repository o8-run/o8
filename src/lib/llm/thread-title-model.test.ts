import { describe, expect, it } from 'vitest';
import { titleModels } from './thread-auto-title';

describe('titleModels', () => {
  it('tries the configured [text_generation] title_model first, then the free chain', () => {
    const free = titleModels('');
    expect(free.length).toBeGreaterThan(0);
    expect(titleModels(undefined)).toEqual(free);
    expect(titleModels(' x/model ')).toEqual(['x/model', ...free]);
    expect(titleModels(free[0])).toEqual(free);
  });
});
