// Pure independent fixture encoder, shared by the test driver and synthetic ACP peer.
const families = ['json', 'percent', 'base64', 'base64url'];
const recipes = [[], ['unicode'], ['selective'], ['uri'], ['form'], ['percent']];
for (const first of families) {
  recipes.push([first]);
  for (const second of families) {
    recipes.push([first, second]);
    for (const third of families) recipes.push([first, second, third]);
  }
}
for (let offset = 0; offset < 12; offset++) recipes.push([`selective:${offset}`]);
for (const outer of ['path-base64', 'path-base64url', 'whitespace-base64']) {
  for (const inner of ['json', 'percent', 'base64']) recipes.push([inner, outer]);
}
recipes.push(['mixed'], ['interrupted'], ['replacement-prefix']);

function encode(value, steps) {
  for (const step of steps) {
    if (step === 'json') value = JSON.stringify(value).slice(1, -1).replace(/\//g, '\\/');
    else if (step === 'unicode') value = value.split('').map((char, index) =>
      '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')[index % 2 ? 'toUpperCase' : 'toLowerCase']()).join('');
    else if (step.startsWith('selective')) {
      const offset = Number(step.split(':')[1] ?? 0);
      value = value.split('').map((char, index) => index % 12 === offset
        ? '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')
        : JSON.stringify(char).slice(1, -1)).join('');
    } else if (step === 'percent') value = [...Buffer.from(value)].map((byte, index) =>
      '%' + byte.toString(16).padStart(2, '0')[index % 2 ? 'toUpperCase' : 'toLowerCase']()).join('');
    else if (step === 'mixed') value = [...value].map((char, index) => index % 3 === 0 ? encodeURIComponent(char)
      : index % 3 === 1 ? char.split('').map(unit => '\\u' + unit.charCodeAt(0).toString(16).padStart(4, '0')).join('')
      : JSON.stringify(char).slice(1, -1)).join('');
    else if (step === 'replacement-prefix') value = 'prefix' + Buffer.from(JSON.stringify(value).slice(1, -1)).toString('base64');
    else if (step === 'interrupted') value = Buffer.from(Buffer.from(value).toString('base64')).toString('base64');
    else if (step.startsWith('path-')) value = '/' + Buffer.from(value).toString(step.slice(5)) + '/suffix';
    else if (step === 'whitespace-base64') value = Buffer.from(value).toString('base64').replace(/(.{4})/g, '$1\r\n');
    else if (step === 'uri') value = encodeURI(value).replace(/%[a-f0-9]{2}/gi, (part, offset) => offset % 2 ? part.toLowerCase() : part.toUpperCase());
    else if (step === 'form') value = new URLSearchParams({ token: value }).toString().slice(6);
    else value = Buffer.from(value).toString(step);
  }
  return value;
}
module.exports = { recipes: recipes.map((steps, index) => ({ name: `${index}:${steps.join('/') || 'raw'}`, steps })), encode };
