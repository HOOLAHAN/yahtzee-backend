import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const profile = process.env.AWS_PROFILE || 'iain-hoolahan';
const work = mkdtempSync(join(tmpdir(), 'yahtzee-profile-sandbox-'));
const archive = join(work, 'profile-service.zip');

const run = (command, args) => {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, AWS_PROFILE: profile },
  });
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? 1}`);
};

try {
  run('zip', ['-j', archive, 'amplify/backend/function/profile-service/handler.mjs']);
  run('aws', [
    'lambda', 'update-function-code',
    '--function-name', 'YahtzeeProfileService-sandbox',
    '--zip-file', `fileb://${archive}`,
    '--region', 'eu-west-2',
  ]);
  run('aws', [
    'lambda', 'wait', 'function-updated-v2',
    '--function-name', 'YahtzeeProfileService-sandbox',
    '--region', 'eu-west-2',
  ]);
} finally {
  rmSync(work, { recursive: true, force: true });
}
