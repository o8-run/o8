// Independent deterministic corpus; no production normalization is imported.
const canaries = ['synthetic-alpha-credential-8341', 'synthetic-quoted:"café"/<>?+=😀', 'synthetic-path:C:\\vault\\token%end'];
const separators = [];
for (let cp = 0; cp <= 0x10ffff; cp++) if (/[\p{White_Space}\p{Separator}]/u.test(String.fromCodePoint(cp))) separators.push(String.fromCodePoint(cp));
for (const value of ['\0', '\x01', '\x1f', '\x7f', '\u200b', '\u2060', '|', ':', '💠']) if (!separators.includes(value)) separators.push(value);
const benign = ['100% complete', 'Working on it', 'C:\\Users\\fixture\\project\\file.ts', '/tmp/project/file.ts',
 'https://example.invalid/a%20b?q=100%25&x=hello+world', '{"path":"C:\\\\tmp\\\\file","progress":"100%"}', 'broken %GG and \\u0ZZZ stay visible', 'plain 日本語 text'];
const forms = {
 raw: value => value,
 json: value => JSON.stringify(value).slice(1,-1),
 unicode: value => value.split('').map((c,i) => '\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')[i%2?'toUpperCase':'toLowerCase']()).join(''),
 percent: value => [...Buffer.from(value)].map((b,i) => '%'+b.toString(16).padStart(2,'0')[i%2?'toUpperCase':'toLowerCase']()).join(''),
 base64: value => Buffer.from(value).toString('base64'),
 base64url: value => Buffer.from(value).toString('base64url'),
};
function insert(value, separator, seed) {
 let random=seed+1; const positions=new Set();
 while(positions.size<Math.min(3,value.length-1)) { random=(Math.imul(random,1664525)+1013904223)>>>0;positions.add(1+random%(value.length-1)); }
 return value.split('').map((c,i)=>(positions.has(i)?separator:'')+c).join('');
}
function rows(separator, family) {
 return Object.entries(forms).filter(([name]) => family==='all'||(family==='base64'?name.startsWith('base64'):!name.startsWith('base64')))
 .flatMap(([name,encode],form) => canaries.map((secret,index) => ({id:`${name}-${index}`,secret,
  value:`CASE ${name}-${index}: ${insert(encode(secret),separator,form*97+index*13)}!\n`, expected:`CASE ${name}-${index}: [redacted]!\n`})));
}
module.exports={canaries,separators,benign,forms,insert,rows};
