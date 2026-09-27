import { loadDemo } from '../demo';

const t = Date.now();
const n = await loadDemo((m) => process.stdout.write(`\r${m.padEnd(60)}`));
console.log(`\nGenerated ${n} demo activities in ${((Date.now() - t) / 1000).toFixed(1)}s`);
