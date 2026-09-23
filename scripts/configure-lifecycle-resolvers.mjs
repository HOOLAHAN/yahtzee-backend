import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const stage = process.argv[2] || 'sandbox';
if (!['sandbox', 'production'].includes(stage)) throw new Error('Use sandbox or production.');
if (stage === 'production' && process.env.CONFIRM_PRODUCTION !== 'deploy-existing-yahtzee-production') throw new Error('Production resolver changes require explicit confirmation.');
const apiId = stage === 'sandbox' ? 'ugvdkhksofdfzbu232gy2gbz5i' : 'lg4sjpo3qndy7pfa3pxvp3uzsa';
const profile = process.env.AWS_PROFILE || 'iain-hoolahan';
const region = 'eu-west-2';
const env = { ...process.env, AWS_PROFILE: profile };
const output = spawnSync('aws', ['cloudformation', 'describe-stacks', '--stack-name', `YahtzeeLifecycleEmail-${stage}`, '--region', region, '--query', 'Stacks[0].Outputs', '--output', 'json'], { encoding: 'utf8', env });
if (output.status !== 0) throw new Error(output.stderr || 'Lifecycle stack not found.');
const values = Object.fromEntries(JSON.parse(output.stdout).map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]));
const dataSourceName = 'LifecycleEmailService';
const existingSource = spawnSync('aws', ['appsync', 'get-data-source', '--api-id', apiId, '--name', dataSourceName, '--region', region], { encoding: 'utf8', env });
const sourceAction = existingSource.status === 0 ? 'update-data-source' : 'create-data-source';
const source = spawnSync('aws', ['appsync', sourceAction, '--api-id', apiId, '--name', dataSourceName, '--type', 'AWS_LAMBDA', '--service-role-arn', values.AppSyncRoleArn, '--lambda-config', `lambdaFunctionArn=${values.FunctionArn}`, '--region', region], { encoding: 'utf8', env });
if (source.status !== 0) throw new Error(source.stderr || 'Unable to configure lifecycle data source.');
for (const [type, field] of [['Query', 'myLifecycleEmailPreference'], ['Query', 'adminEmailHistory'], ['Mutation', 'updateMyLifecycleEmailPreference'], ['Mutation', 'recordClientActivity'], ['Mutation', 'deleteMyLifecycleEmailData']]) {
  const request = readFileSync(`amplify/backend/api/yahtzee/resolvers/${type}.${field}.req.vtl`, 'utf8');
  const response = readFileSync(`amplify/backend/api/yahtzee/resolvers/${type}.${field}.res.vtl`, 'utf8');
  const lookup = spawnSync('aws', ['appsync', 'get-resolver', '--api-id', apiId, '--type-name', type, '--field-name', field, '--region', region], { encoding: 'utf8', env });
  const action = lookup.status === 0 ? 'update-resolver' : 'create-resolver';
  const result = spawnSync('aws', ['appsync', action, '--api-id', apiId, '--type-name', type, '--field-name', field, '--data-source-name', dataSourceName, '--request-mapping-template', request, '--response-mapping-template', response, '--region', region], { encoding: 'utf8', env });
  if (result.status !== 0) throw new Error(result.stderr || `Unable to configure ${field}.`);
  console.log(`Configured ${type}.${field} in ${stage}.`);
}
