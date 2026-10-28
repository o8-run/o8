import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// Linux previews ship with every stable release (#1672): a published, non-
// prerelease GitHub release dispatches Port Build for that tag, Linux only.
// Port Build owns the build, signing, attestation and upload gates.

type Mapping = Record<string, unknown>;
const read = (name: string) => parse(readFileSync(path.join(process.cwd(), '.github', 'workflows', name), 'utf8')) as Mapping;

const workflow = read('linux-release-preview.yml');
const job = (workflow.jobs as Mapping).dispatch as Mapping;
const steps = job.steps as Mapping[];
const script = String(steps[0].run);

describe('linux-release-preview workflow', () => {
  it('runs only for published stable releases', () => {
    expect(workflow.on).toEqual({ release: { types: ['published'] } });
    expect(job.if).toBe('${{ !github.event.release.prerelease && !github.event.release.draft }}');
    expect(script).toContain('^v[0-9]+\\.[0-9]+\\.[0-9]+$');
  });

  it('holds only the permission needed to dispatch, and no secrets', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(job.permissions).toEqual({ actions: 'write' });
    expect(JSON.stringify(workflow)).not.toContain('secrets.');
    expect(steps).toHaveLength(1);
    expect(steps[0].uses).toBeUndefined();
  });

  it('dispatches Port Build from the tag with publish_target linux and no asset replacement', () => {
    expect(steps[0].env).toMatchObject({ RELEASE_TAG: '${{ github.event.release.tag_name }}' });
    expect(script).toMatch(/gh workflow run port-build\.yml --ref "\$RELEASE_TAG"/);
    expect(script).toContain('-f release_tag="$RELEASE_TAG"');
    expect(script).toContain('-f publish_target=linux');
    expect(script).not.toMatch(/replace_existing_assets|publish_to_mirror|sign_windows/);
    // The release tag reaches the shell only through env, never inline.
    expect(script).not.toContain('${{');
  });

  it('targets Port Build inputs that still exist', () => {
    const dispatch = ((read('port-build.yml').on as Mapping).workflow_dispatch as Mapping).inputs as Mapping;
    expect(Object.keys(dispatch)).toEqual(expect.arrayContaining(['release_tag', 'publish_target']));
    expect((dispatch.publish_target as Mapping).options).toContain('linux');
  });
});
