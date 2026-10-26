export interface KnowledgeSource {
  id: string;
  name: string;
  path: string;
  include: string[];
  exclude: string[];
}
export interface KnowledgeSourceDefaults { knowledgeSources: KnowledgeSource[] }
export function parseKnowledgeSources(value: unknown): KnowledgeSource[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error('Knowledge sources must be a list of at most 32 folders.');
  const ids = new Set<string>(); const paths = new Set<string>();
  const patterns = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 32
    && v.every(p => typeof p === 'string' && p.length > 0 && p.length <= 240 && !/[\\\x00\r\n\[\]{}]/.test(p) && !p.split('/').includes('..') && !p.startsWith('/'));
  return value.map(raw => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid knowledge source.');
    const s = raw as KnowledgeSource;
    if (!/^[a-f0-9-]{36}$/.test(s.id) || typeof s.name !== 'string' || !s.name.trim() || s.name.length > 120
      || typeof s.path !== 'string' || !s.path || s.path.length > 4096 || /[\x00\r\n]/.test(s.path)
      || !patterns(s.include) || !s.include.length || !patterns(s.exclude) || ids.has(s.id) || paths.has(s.path)) throw new Error('Invalid or duplicate knowledge source. Use relative patterns with *, ** or ?.');
    ids.add(s.id); paths.add(s.path);
    return { id: s.id, name: s.name.trim(), path: s.path, include: [...s.include], exclude: [...s.exclude] };
  });
}
