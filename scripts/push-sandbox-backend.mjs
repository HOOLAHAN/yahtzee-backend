import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const parametersPath = new URL('../amplify/backend/api/yahtzee/parameters.json', import.meta.url);
const original = readFileSync(parametersPath, 'utf8');
const parameters = JSON.parse(original);

// Amplify Gen 1 does not resolve this dependency correctly for a newly added
// environment. Keep the repository default pointed at production and inject
// the sandbox pool only for the duration of a sandbox deployment.
parameters.AuthCognitoUserPoolId = 'eu-west-2_e3QMax7lJ';

try {
  writeFileSync(parametersPath, `${JSON.stringify(parameters, null, 2)}\n`);
  const checkout = spawnSync(
    'npx',
    ['@aws-amplify/cli@14.5.1', 'env', 'checkout', 'sandbox'],
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
