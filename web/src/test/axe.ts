import axe from 'axe-core';
import { expect } from 'vitest';

/**
 * Component-level accessibility smoke check.
 *
 * jsdom has no layout or rendering engine, so `color-contrast` is disabled here; contrast
 * is covered by the Playwright axe scans in `e2e/a11y`. The remaining rules catch
 * structural problems early: missing names, invalid ARIA, broken listbox/table semantics.
 */
export async function expectNoBlockingAxeViolations(
  container: Element = document.body,
): Promise<void> {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false } },
  });
  const blocking = results.violations.filter(
    (violation) => violation.impact === 'critical' || violation.impact === 'serious',
  );
  const summary = blocking
    .map(
      (violation) =>
        `${violation.id} [${violation.impact}] ${violation.help}: ${violation.nodes
          .map((node) => node.target.join(' '))
          .join(', ')}`,
    )
    .join('\n');

  expect(blocking, summary).toEqual([]);
}
