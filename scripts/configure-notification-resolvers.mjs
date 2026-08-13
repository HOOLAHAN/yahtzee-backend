import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const stage = process.argv[2] ?? 'sandbox';
if (!['sandbox', 'production'].includes(stage)) throw new Error('Use sandbox or production.');
if (stage === 'production' && process.env.CONFIRM_PRODUCTION !== 'deploy-existing-yahtzee-production') throw new Error('Production resolver changes require explicit confirmation.');
const apiId = stage === 'sandbox' ? 'ugvdkhksofdfzbu232gy2gbz5i' : 'lg4sjpo3qndy7pfa3pxvp3uzsa';
const profile = process.env.AWS_PROFILE || 'iain-hoolahan';
const region = 'eu-west-2';
const fields = ['updateMyPushNotifications', 'sendAdminNotification'];
for (const field of fields) {
  const resolverArgs = ['--api-id', apiId, '--type-name', 'Mutation', '--field-name', field, '--data-source-name', 'ProfileService', '--request-mapping-template', readFileSync(`amplify/backend/api/yahtzee/resolvers/Mutation.${field}.req.vtl`, 'utf8'), '--response-mapping-template', readFileSync(`amplify/backend/api/yahtzee/resolvers/Mutation.${field}.res.vtl`, 'utf8'), '--region', region];
  let args = ['appsync', 'create-resolver', ...resolverArgs];
  let result = spawnSync('aws', args, { encoding: 'utf8', env: { ...process.env, AWS_PROFILE: profile } });
  if (result.status !== 0 && result.stderr.includes('AlreadyExistsException')) {
    args = ['appsync', 'update-resolver', ...resolverArgs];
    result = spawnSync('aws', args, { encoding: 'utf8', env: { ...process.env, AWS_PROFILE: profile } });
  }
  if (result.status !== 0) throw new Error(result.stderr || `Unable to configure ${field}`);
  console.log(`Configured Mutation.${field} in ${stage}.`);
}
