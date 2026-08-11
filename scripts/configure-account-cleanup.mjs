import { spawnSync } from 'node:child_process';

const profile = process.env.AWS_PROFILE || 'iain-hoolahan';
const region = 'eu-west-2';
const stage = process.argv[2];
if (!['sandbox', 'production'].includes(stage)) throw new Error('Usage: node scripts/configure-account-cleanup.mjs sandbox|production');
if (stage === 'production' && process.env.CONFIRM_PRODUCTION !== 'deploy-existing-yahtzee-production') {
  throw new Error('Production requires CONFIRM_PRODUCTION=deploy-existing-yahtzee-production');
}

const functionName = stage === 'sandbox' ? 'YahtzeeProfileService-sandbox' : 'YahtzeeProfileService';
const suffix = stage === 'sandbox' ? 'sandbox' : 'production';
const ruleName = `YahtzeeUnconfirmedAccountCleanup-${suffix}`;
const statementId = `EventBridgeAccountCleanup-${suffix}`;
const env = { ...process.env, AWS_PROFILE: profile };

function aws(args, { allowFailure = false } = {}) {
  const result = spawnSync('aws', [...args, '--region', region], { env, encoding: 'utf8' });
  if (result.status !== 0 && !allowFailure) throw new Error(result.stderr || `aws ${args.join(' ')} failed`);
  return result.stdout.trim();
}

const config = JSON.parse(aws(['lambda', 'get-function-configuration', '--function-name', functionName, '--output', 'json']));
const poolId = config.Environment?.Variables?.USER_POOL_ID;
if (!poolId) throw new Error(`${functionName} has no USER_POOL_ID environment variable.`);
const functionArn = config.FunctionArn;
const roleName = String(config.Role).split('/').pop();
const accountId = functionArn.split(':')[4];
const poolArn = `arn:aws:cognito-idp:${region}:${accountId}:userpool/${poolId}`;

aws(['iam', 'put-role-policy', '--role-name', roleName, '--policy-name', 'YahtzeeUnconfirmedAccountCleanup', '--policy-document', JSON.stringify({
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Action: ['cognito-idp:ListUsers', 'cognito-idp:AdminDeleteUser'], Resource: poolArn }],
})]);
const ruleArn = JSON.parse(aws(['events', 'put-rule', '--name', ruleName, '--schedule-expression', 'cron(15 3 * * ? *)', '--state', 'ENABLED', '--description', 'Delete Yahtzee Cognito accounts still unconfirmed after the retention period', '--output', 'json'])).RuleArn;
const permission = aws(['lambda', 'add-permission', '--function-name', functionName, '--statement-id', statementId, '--action', 'lambda:InvokeFunction', '--principal', 'events.amazonaws.com', '--source-arn', ruleArn], { allowFailure: true });
if (!permission) console.info('Lambda invocation permission already exists.');
aws(['events', 'put-targets', '--rule', ruleName, '--targets', JSON.stringify([{ Id: 'account-cleanup', Arn: functionArn, Input: JSON.stringify({ source: 'yahtzee.account-cleanup' }) }])]);
console.info(`Configured daily unconfirmed-account cleanup for ${functionName} (${poolId}).`);
