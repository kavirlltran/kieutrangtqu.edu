const fs = require('fs');
const lines = fs.readFileSync('app/page.tsx', 'utf8').split('\n');
fs.writeFileSync('app/page.tsx', lines.slice(0, 3438).join('\n') + '\n', 'utf8');
console.log('Done. Lines:', fs.readFileSync('app/page.tsx', 'utf8').split('\n').length);
