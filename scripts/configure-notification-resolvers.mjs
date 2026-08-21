import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const stage = process.argv[2] ?? 'sandbox';
if (!['sandbox', 'production'].includes(stage)) throw new Error('Use sandbox or production.');
if (stage === 'production' && process.env.CONFIRM_PRODUCTION !== 'deploy-existing-yahtzee-production') throw new Error('Production resolver changes require explicit confirmation.');
const apiId = stage === 'sandbox' ? 'ugvdkhksofdfzbu232gy2gbz5i' : 'lg4sjpo3qndy7pfa3pxvp3uzsa';
const profile = process.env.AWS_PROFILE || 'iain-hoolahan';
const region = 'eu-west-2';
const resolvers = [
  { type: 'Query', field: 'adminDashboard' },
  { type: 'Mutation', field: 'updateMyPushNotifications' },
  { type: 'Mutation', field: 'sendAdminNotification' },
];
for (const { type, field } of resolvers) {
  const resolverArgs = ['--api-id', apiId, '--type-name', type, '--field-name', field, '--data-source-name', 'ProfileService', '--request-mapping-template', readFileSync(`amplify/backend/api/yahtzee/resolvers/${type}.${field}.req.vtl`, 'utf8'), '--response-mapping-template', readFileSync(`amplify/backend/api/yahtzee/resolvers/${type}.${field}.res.vtl`, 'utf8'), '--region', region];
  const lookup = spawnSync('aws', ['appsync', 'get-resolver', '--api-id', apiId, '--type-name', type, '--field-name', field, '--region', region], { encoding: 'utf8', env: { ...process.env, AWS_PROFILE: profile } });
  const action = lookup.status === 0 ? 'update-resolver' : 'create-resolver';
  const result = spawnSync('aws', ['appsync', action, ...resolverArgs], { encoding: 'utf8', env: { ...process.env, AWS_PROFILE: profile } });
  if (result.status !== 0) throw new Error(result.stderr || `Unable to configure ${field}`);
  console.log(`Configured ${type}.${field} in ${stage}.`);
}
