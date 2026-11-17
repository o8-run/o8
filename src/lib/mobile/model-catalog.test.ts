import { describe, expect, it } from 'vitest';
import { CODEX_MODEL_IDS } from '@/lib/models';
import { codexModelsForAccount, mobileModelCatalog } from './model-catalog';

const codex = (models?: readonly string[]) =>
  mobileModelCatalog(models).agents.find(agent => agent.id === 'codex')!;

describe('Codex models offered to a phone', () => {
  it('offers only the models the signed-in account can run', () => {
    const offered = codexModelsForAccount([{ slug: 'gpt-5.6-sol' }, { slug: 'gpt-5.6-luna' }, { slug: 'codex-auto-review' }]);
    expect(offered).toEqual(['gpt-5.6-sol', 'gpt-5.6-luna']);
    const agent = codex(offered);
    expect(agent.models.map(model => model.id)).toEqual(['gpt-5.6-sol', 'gpt-5.6-luna']);
    // The default must be a model the account has, never the newest one it lacks.
    expect(offered).toContain(agent.defaultModel);
  });

  it('keeps the full list when the account record is missing or names none of ours', () => {
    expect(codexModelsForAccount(null)).toEqual(CODEX_MODEL_IDS);
    expect(codexModelsForAccount([])).toEqual(CODEX_MODEL_IDS);
    expect(codexModelsForAccount([{ slug: 'some-future-model' }])).toEqual(CODEX_MODEL_IDS);
  });
});
