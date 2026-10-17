import { readP10bPublicJson } from '../server/services/p10bOperatorFiles.js';
import fs from 'node:fs';
import { sha256 } from '../server/utils/security.js';
import { checkP10bOwnerRecipe, prepareP10bOwnerBundle, validateP10bOwnerPublicInputs } from '../server/services/p10bOwnerPreflight.js';
try {
  const args = process.argv.slice(2); let result;
  if (args.length === 3 && args[0] === '--check-only' && args[1] === '--recipe') result = {
    ...checkP10bOwnerRecipe(readP10bPublicJson(args[2])), recipeFileSha256: sha256(fs.readFileSync(args[2])) };
  else if (args.length === 7 && args[0] === '--validate-input' && args[1] === '--recipe' && args[3] === '--receipt' && args[5] === '--permission') {
    result = validateP10bOwnerPublicInputs({ recipe: readP10bPublicJson(args[2]), receipt: readP10bPublicJson(args[4]), permission: readP10bPublicJson(args[6]) });
  }
  else if (args.length === 7 && args[0] === '--prepare' && args[1] === '--recipe' && args[3] === '--receipt' && args[5] === '--permission') {
    result = await prepareP10bOwnerBundle({ recipe: readP10bPublicJson(args[2]), receipt: readP10bPublicJson(args[4]), permission: readP10bPublicJson(args[6]) });
  } else throw Error('Arguments denied');
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch { process.stderr.write('Owner preflight held; preserve evidence.\n'); process.exitCode = 1; }
