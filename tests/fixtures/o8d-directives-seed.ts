import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProject, addRepoToProject } from '../../src/lib/projects/store';
import { closeDb } from '../../src/lib/db';
const root = process.env.CORTEX_IDE_DATA_DIR!;
if (readFileSync(join(root, 'fixture-owner'), 'utf8') !== 'o8d-native-read/v1') throw Error('Owned directives fixture required');
try {
  const project = createProject({ name: 'Fixture Project', slug: 'fixture-project' });
  addRepoToProject(project.id, 'directives-repo');
  writeFileSync(join(root, 'projects.json'), JSON.stringify({ projects: [{ id: project.id, name: project.name, repoPaths: [join(root, 'fixture-repo')], createdAt: '2026-01-01T00:00:00.000Z' }], activeProjectId: project.id }));
  writeFileSync(join(root, 'directives-fixture.json'), JSON.stringify({ projectId: project.id }));
} finally { closeDb(); }
