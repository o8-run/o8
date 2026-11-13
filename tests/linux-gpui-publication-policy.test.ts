import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = parse(readFileSync('.github/workflows/linux-gpui-publish.yml', 'utf8'));

it('requires a manual opt-in before granting release write access', () => {
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  expect(workflow.on.workflow_dispatch.inputs.publish_linux).toMatchObject({ type: 'boolean', default: false });
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(workflow.jobs.attach.if).toBe('inputs.publish_linux == true');
});

it('authenticates exact-tag GPUI bytes before an upload without replacement or feed writes', () => {
  const commands = workflow.jobs.attach.steps.filter((step: { run?: string }) => step.run)
    .map((step: { run: string }) => step.run).join('\n');
  const verification = commands.indexOf('assertLinuxArtifactChannels(process.cwd()');
  const upload = commands.indexOf('gh release upload');
  expect(commands).toContain('run.head_sha !== process.env.EXPECTED_SHA');
  expect(commands).toContain('run.path !== ".github/workflows/linux-downloads.yml"');
  expect(verification).toBeGreaterThan(0);
  expect(upload).toBeGreaterThan(verification);
  expect(commands).not.toContain('--clobber');
  expect(commands).not.toMatch(/publish\/\*\.(deb|rpm)/);
  expect(commands).not.toMatch(/(?:latest|beta|preview)\.json/);
});
