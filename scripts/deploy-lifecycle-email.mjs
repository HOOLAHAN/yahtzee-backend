import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const stage = process.argv[2] || 'sandbox';
if (!['sandbox', 'production'].includes(stage)) throw new Error('Use sandbox or production.');
if (stage === 'production' && process.env.CONFIRM_PRODUCTION !== 'deploy-existing-yahtzee-production') throw new Error('Production lifecycle deployment requires explicit confirmation.');
const profile = process.env.AWS_PROFILE || 'iain-hoolahan';
const region = 'eu-west-2';
const config = stage === 'sandbox'
  ? { apiId: 'ugvdkhksofdfzbu232gy2gbz5i', userPoolId: 'eu-west-2_e3QMax7lJ', gameTable: 'GameResult-ugvdkhksofdfzbu232gy2gbz5i-sandbox' }
  : { apiId: 'lg4sjpo3qndy7pfa3pxvp3uzsa', userPoolId: 'eu-west-2_fktkjskrl', gameTable: 'GameResult-lg4sjpo3qndy7pfa3pxvp3uzsa-dev' };
const env = { ...process.env, AWS_PROFILE: profile };
const defaultSettings = {
  DryRun: 'true',
  EnableFirstGame: 'false',
  EnableDownloadApp: 'false',
  EnableInactivePlayer: 'false',
  EnableIncompleteSignup: stage === 'sandbox' ? 'true' : 'false',
};
const settings = { ...defaultSettings };
if (stage === 'production') {
  const existing = spawnSync('aws', [
    'cloudformation', 'describe-stacks', '--stack-name', 'YahtzeeLifecycleEmail-production',
    '--region', region, '--query', 'Stacks[0].Parameters', '--output', 'json',
  ], { encoding: 'utf8', env });
  if (existing.status !== 0) throw new Error(existing.stderr || 'Unable to inspect existing production lifecycle settings.');
  const parameters = Object.fromEntries(JSON.parse(existing.stdout).map(({ ParameterKey, ParameterValue }) => [ParameterKey, ParameterValue]));
  for (const key of Object.keys(settings)) {
    if (['true', 'false'].includes(parameters[key])) settings[key] = parameters[key];
  }
}
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: 'inherit', env, ...options });
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? 1}`);
};
const temp = mkdtempSync(join(tmpdir(), `yahtzee-lifecycle-${stage}-`));
const archive = join(temp, 'lifecycle.zip');
try {
  run('aws', ['cloudformation', 'deploy', '--stack-name', `YahtzeeLifecycleEmail-${stage}`, '--template-file', 'infrastructure/lifecycle-email/template.yaml', '--capabilities', 'CAPABILITY_NAMED_IAM', '--parameter-overrides', `Stage=${stage}`, `UserPoolId=${config.userPoolId}`, `GameResultTable=${config.gameTable}`, `AppSyncApiId=${config.apiId}`, ...Object.entries(settings).map(([key, value]) => `${key}=${value}`), '--region', region]);
  run('zip', ['-j', archive, 'infrastructure/lifecycle-email/src/handler.mjs']);
  run('aws', ['lambda', 'update-function-code', '--function-name', `YahtzeeLifecycleService-${stage}`, '--zip-file', `fileb://${archive}`, '--region', region]);
  run('aws', ['lambda', 'wait', 'function-updated-v2', '--function-name', `YahtzeeLifecycleService-${stage}`, '--region', region]);
  console.log(`Lifecycle stack deployed to ${stage} with settings: ${JSON.stringify(settings)}.`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
