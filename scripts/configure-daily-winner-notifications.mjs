import { spawnSync } from 'node:child_process';

const stage = process.argv[2] ?? 'sandbox';
if (!['sandbox', 'production'].includes(stage)) throw new Error('Use sandbox or production.');
if (stage === 'production' && process.env.CONFIRM_PRODUCTION !== 'deploy-existing-yahtzee-production') throw new Error('Production scheduling blocked without explicit confirmation.');
const profile = process.env.AWS_PROFILE || 'iain-hoolahan';
const region = 'eu-west-2';
const functionName = stage === 'sandbox' ? 'YahtzeeProfileService-sandbox' : 'YahtzeeProfileService';
const suffix = stage === 'sandbox' ? 'sandbox' : 'production';
const ruleName = `yahtzee-daily-winner-notifications-${suffix}`;
const statementId = `EventBridgeDailyWinners-${suffix}`;
const run = (args, allowFailure = false) => { const result = spawnSync('aws', args, { encoding: 'utf8', env: { ...process.env, AWS_PROFILE: profile } }); if (result.status !== 0 && !allowFailure) throw new Error(result.stderr || `aws ${args.join(' ')} failed`); return result.stdout.trim(); };

// The Lambda gates this hourly rule with Europe/London time and a DynamoDB
// idempotency marker, preserving 10am delivery across GMT and BST.
const ruleArn = JSON.parse(run(['events', 'put-rule', '--name', ruleName, '--schedule-expression', 'cron(0 * * * ? *)', '--state', 'ENABLED', '--region', region])).RuleArn;
const functionArn = run(['lambda', 'get-function', '--function-name', functionName, '--region', region, '--query', 'Configuration.FunctionArn', '--output', 'text']);
run(['lambda', 'remove-permission', '--function-name', functionName, '--statement-id', statementId, '--region', region], true);
run(['lambda', 'add-permission', '--function-name', functionName, '--statement-id', statementId, '--action', 'lambda:InvokeFunction', '--principal', 'events.amazonaws.com', '--source-arn', ruleArn, '--region', region]);
run(['events', 'put-targets', '--rule', ruleName, '--targets', JSON.stringify([{ Id: 'DailyWinnerNotifications', Arn: functionArn, Input: JSON.stringify({ source: 'yahtzee.daily-winner-notifications' }) }]), '--region', region]);
console.log(`Configured ${ruleName} for ${functionName}.`);
