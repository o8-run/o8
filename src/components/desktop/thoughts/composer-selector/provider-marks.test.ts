import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { O8Mark } from './provider-marks';

describe('O8Mark', () => {
  it('draws the one-colour Ring: the cut outline and the review point', () => {
    const markup = renderToStaticMarkup(createElement(O8Mark, { size: 16 }));
    expect(markup).toContain('viewBox="0 0 100 100"');
    expect(markup).toContain('width="16"');
    // Outer edge, cut, inner edge and cut back, then the point at (71.92, 28.08).
    expect(markup).toContain('A40 40 0 1 1 73.1 17.344');
    expect(markup).toContain('A22 22 0 1 0 68.683 38.383');
    expect(markup).toContain('<circle cx="71.92" cy="28.08" r="7.4"');
    expect(markup).toContain('fill="currentColor"');
  });
});
