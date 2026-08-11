import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const confirmation = 'deploy-existing-yahtzee-production';
if (process.env.CONFIRM_PRODUCTION !== confirmation) {
  console.error(`Production deployment blocked. Set CONFIRM_PRODUCTION=${confirmation} after reviewing the live change.`);
  process.exit(1);
}

const parametersPath = new URL('../amplify/backend/api/yahtzee/parameters.json', import.meta.url);
const original = readFileSync(parametersPath, 'utf8');
const parameters = JSON.parse(original);

// The historical Amplify environment named "dev" is the live App Store and
// website backend. Inject its existing Cognito pool explicitly so a missing
// generated parameter can never detach AppSync authorization during a push.
parameters.AuthCognitoUserPoolId = 'eu-west-2_fktkjskrl';

try {
  writeFileSync(parametersPath, `${JSON.stringify(parameters, null, 2)}\n`);
  const checkout = spawnSync(
    'npx',
    ['@aws-amplify/cli@14.5.1', 'env', 'checkout', 'dev'],
    { stdio: 'inherit', env: { ...process.env, AWS_PROFILE: process.env.AWS_PROFILE || 'iain-hoolahan' } },
  );
  if (checkout.status !== 0) process.exitCode = checkout.status || 1;
  else {
    const push = spawnSync('npx', ['@aws-amplify/cli@14.5.1', 'push', '--yes'], {
      stdio: 'inherit',
      env: { ...process.env, AWS_PROFILE: process.env.AWS_PROFILE || 'iain-hoolahan' },
    });
    process.exitCode = push.status || 0;
  }
} finally {
  writeFileSync(parametersPath, original);
}
