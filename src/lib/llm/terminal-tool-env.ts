import { childEnvironment } from '@/lib/providers/spawn-environment';

export function terminalToolEnv(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(childEnvironment({ inject: false })).filter(([key]) => !(
        /(?:^|_)(?:API_?)?KEY$/i.test(key)
        || /(?:^|_)(?:TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIALS?|PRIVATE_KEY)$/i.test(key)
        || /^(?:AWS|AZURE|GOOGLE|GCP|OPENAI|ANTHROPIC|OPENROUTER|GEMINI|XAI)_/i.test(key)
        || key === 'O8_ANALYTICS_TOKEN'
        || key === 'WS_TOKEN'
      )),
    ),
    NODE_ENV: process.env.NODE_ENV ?? 'development',
  };
}
