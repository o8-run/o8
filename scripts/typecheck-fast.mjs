import { resolveTypecheckChecker } from './typecheck-checker.mjs';
import { runTypecheckProcess } from './typecheck-process.mjs';

const checker = resolveTypecheckChecker();
process.exit(runTypecheckProcess(checker.path, process.argv.slice(2)));
