import { spawnSync } from 'node:child_process';

const stage = process.argv[2] || 'sandbox';
if (!['sandbox', 'production'].includes(stage)) throw new Error('Use sandbox or production.');
if (stage === 'production' && process.env.CONFIRM_PRODUCTION !== 'deploy-existing-yahtzee-production') throw new Error('Production template changes require explicit confirmation.');
// SES templates are regional/account-wide, so even sandbox configuration uses
// the production-ready consent and unsubscribe wording. Campaigns remain off.
const profile = process.env.AWS_PROFILE || 'iain-hoolahan';
for (const name of ['yahtzee-first-game', 'yahtzee-download-app', 'yahtzee-inactive-player', 'yahtzee-incomplete-signup']) {
  const result = spawnSync('aws', ['sesv2', 'update-email-template', '--cli-input-json', `file://infrastructure/lifecycle-email/templates/${name}.json`, '--region', 'eu-west-2'], { stdio: 'inherit', env: { ...process.env, AWS_PROFILE: profile } });
  if (result.status !== 0) throw new Error(`Unable to update ${name}.`);
}
console.log('Lifecycle marketing templates contain consent wording and unsubscribe links; the incomplete-signup template is service-only.');
