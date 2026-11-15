import { useEffect, useState } from 'react';
import { useO8Auth } from '@/components/auth/O8AuthProvider';
import { planConnectionRequest } from '@/lib/chatgpt-plan/client';
import { API_MODELS, buildOpencodeModels, CLI_RUNTIME_MODELS, type ModelOption } from './shared';

export function useChatModelOptions(): ModelOption[] {
  const [cliModels, setCliModels] = useState<ModelOption[]>([]);
  // null = keys not yet fetched (show all to avoid flicker); Set = configured provider IDs
  const [apiKeyProviders, setApiKeyProviders] = useState<Set<string> | null>(null);
  // Operator is always available — it's o8's branded free tier. Other API models require their key.
  const availableApiModels = apiKeyProviders === null
    ? API_MODELS
    : API_MODELS.filter((m) => (
      m.provider === 'operator'
      || m.provider === 'local'
      || apiKeyProviders.has(m.provider)
    ));


  // Detect installed CLI runtimes + configured API keys, then build the visible model list.
  // Only models whose CLI is installed OR whose API key is configured will appear in the picker.
  useEffect(() => {
    (async () => {
      try {
        const [detectRes, keysRes] = await Promise.all([
          fetch('/api/setup/detect').catch(() => null),
          fetch('/api/v2/keys').catch(() => null),
        ]);

        if (detectRes?.ok) {
          const data = await detectRes.json();
          const detected: ModelOption[] = [];
          for (const tool of data.tools ?? []) {
            if (!tool.detected) continue;
            if (tool.id === 'opencode') {
              const authedProviders = Array.isArray(tool.details?.authedProviders)
                ? (tool.details.authedProviders as string[])
                : undefined;
              detected.push(...buildOpencodeModels(authedProviders));
            } else if (CLI_RUNTIME_MODELS[tool.id as string]) {
              detected.push(...CLI_RUNTIME_MODELS[tool.id as string]);
            }
          }
          if (detected.length > 0) setCliModels(detected);
        }

        if (keysRes?.ok) {
          const data = await keysRes.json();
          const configured = new Set<string>(
            (data.providers ?? [])
              .filter((p: { configured: boolean }) => p.configured)
              .map((p: { id: string }) => p.id),
          );
          setApiKeyProviders(configured);
        } else {
          setApiKeyProviders(new Set());
        }
      } catch {
        setApiKeyProviders(new Set());
      }
    })();
  }, []);

  const auth = useO8Auth();
  const [planModels, setPlanModels] = useState<ModelOption[]>([]);
  useEffect(() => {
    let alive = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- drops the previous account's plan models before the reload
    setPlanModels([]);
    const load = async () => {
      if (!auth.signedIn) return;
      try {
        const data = await planConnectionRequest();
        if (!alive) return;
        const models = data.planEnabled && Array.isArray(data.models) ? data.models as Array<{ id: string; label: string }> : [];
        setPlanModels(models.map((model) => ({ id: `chatgpt:${model.id}`, label: model.label, provider: 'chatgpt', backend: 'api', color: 'var(--t-text)', description: 'Using ChatGPT plan · applicable limits' })));
      } catch { if (alive) setPlanModels([]); }
    };
    void load();
    window.addEventListener('o8:chatgpt-plan-changed', load);
    window.addEventListener('focus', load);
    return () => { alive = false; window.removeEventListener('o8:chatgpt-plan-changed', load); window.removeEventListener('focus', load); };
  }, [auth.signedIn, auth.user?.id]);
  return [...cliModels, ...planModels, ...availableApiModels];
}
