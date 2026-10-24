import { writeFileSync } from 'node:fs';
import { TestRunner, vi, type RunnerTask, type RunnerTestFile, type RunnerTestSuite } from 'vitest';
import { captureFixtureClock } from './dated-fixture-surfaces';

export default class DatedFixtureRunner extends TestRunner {
  private readonly clock = captureFixtureClock();

  onCollected(files: RunnerTestFile[]) {
    const selected = process.env.O8_DATED_FIXTURE_TEST;
    const tests: { id: string; name: string }[] = [];
    const visit = (task: RunnerTask, ancestors: string[]): boolean => {
      if (task.mode !== 'run' && task.mode !== 'queued') return false;
      if (task.type === 'test') {
        tests.push({ id: task.id, name: [...ancestors, task.name].join(' > ') });
        if (selected && task.id !== selected) task.mode = 'skip';
        return !selected || task.id === selected;
      }
      const children = task.tasks.map(child => visit(child, [...ancestors, task.name]));
      const included = children.some(Boolean);
      if (selected && !included) task.mode = 'skip';
      return included;
    };
    files.forEach(file => visit(file, []));
    if (selected) {
      if (tests.filter(test => test.id === selected).length !== 1) {
        throw new Error('The isolated dated-fixture test was not collected exactly once');
      }
      // Imports have already been checked under the future clock. Collection
      // can execute unrelated describe bodies too; none may lend a test a pin.
      // Start fresh before running the selected test's own ancestor hooks.
      vi.useRealTimers();
      this.clock.restore();
    } else {
      const output = process.env.O8_DATED_FIXTURE_CASES;
      if (!output || files.length !== 1) throw new Error('A dated-fixture probe requires one collected file');
      writeFileSync(output, JSON.stringify({ file: files[0].filepath, tests }));
    }
  }

  async onAfterRunSuite(suite: RunnerTestSuite) {
    // All afterEach/afterAll hooks and their cleanup callbacks have finished.
    // A fresh worker prevents another test or sibling suite from lending a pin.
    if (suite === suite.file && !this.clock.matches()) {
      suite.result!.state = 'fail';
      suite.result!.errors ??= [];
      suite.result!.errors.push({
        name: 'Error',
        message: 'Restore Date, Intl.DateTimeFormat and performance.timeOrigin after the isolated dated-fixture test and its hooks',
      });
      // Report the failure using clean clocks; automatic cleanup never turns
      // an unrestored pin into a successful validation.
      vi.useRealTimers();
      this.clock.restore();
    }
    await super.onAfterRunSuite(suite);
  }
}
