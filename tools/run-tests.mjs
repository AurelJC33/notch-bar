// Lance tous les tests unitaires sans dépendre de l'expansion des jokers par le
// shell : cmd.exe (Windows) ne développe pas `tests/*.test.mjs`, et Node 20 non plus.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const dir = new URL('../tests/', import.meta.url);
const files = readdirSync(dir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => fileURLToPath(new URL(name, dir)));

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);