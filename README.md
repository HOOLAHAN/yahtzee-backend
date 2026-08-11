# Yahtzee Backend

Shared AWS backend for the Yahtzee Hub website and mobile app.

This repository owns the Amplify Gen 1 GraphQL schema, Cognito configuration,
AppSync resolvers, DynamoDB models, profile/preferences Lambda, and deployment
documentation. Frontend repositories consume its public environment outputs but
do not own backend deployments.

## Environments

| Amplify name | Purpose | Safety rule |
| --- | --- | --- |
| `sandbox` | Local development and EAS development builds | Normal development target |
| `dev` | Live website and App Store production | Historical name; treat as production |

The environments have separate Cognito users, profiles, scores, game results,
and Daily Challenge standings. Existing production data remains in `dev`.

## Prerequisites

- Node.js and npm
- AWS CLI profile `iain-hoolahan`
- Access to AWS account `974928048532` in `eu-west-2`

Install the pinned Amplify CLI on demand through `npx`; a global installation
is not required.

## Development deployment

Check the selected environment:

```bash
npm run status
```

Deploy schema/Auth/AppSync changes only to the sandbox:

```bash
npm run deploy:sandbox
```

The wrapper checks out `sandbox`, injects its Cognito pool ID only during the
Amplify command, and restores the production-safe repository value afterward.
Never use a raw `amplify push` without first checking the active environment.

Deploy a profile Lambda code change after the Amplify deployment:

```bash
npm run deploy:profile:sandbox
```

## Production

Production remains live and deployable from the website repository during this
first migration stage. Do not deploy `dev` from this repository until the
sandbox has been exercised successfully and the production cutover is approved.

## Frontend configuration

- Website `npm start` uses `.env.development.local` and the sandbox.
- Mobile local development uses `.env.local` and the sandbox.
- EAS `development` variables point to the sandbox.
- Website production and EAS `production` continue to point to the live `dev`
  environment.

Environment files contain public client configuration only. Never store AWS
access keys or other private credentials in frontend environment variables.
