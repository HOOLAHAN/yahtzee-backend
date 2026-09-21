# Lifecycle email service

Consent-first lifecycle email support for Yahtzee Hub. The stack creates an isolated state table, Lambda, daily evaluator, SES event consumer, and AppSync invocation role.

All campaign switches default to `false` and `DRY_RUN` defaults to `true`. The incomplete-signup workflow is separate from marketing consent: it sends at most one service-only reminder after 24 hours while a user remains unconfirmed. It contains no promotional copy or marketing-list metadata and stops automatically when Cognito reports the account as confirmed.

The deployment script enables incomplete-signup evaluation in sandbox only, while retaining `DRY_RUN=true`, so eligible counts can be reviewed without sending email. Production keeps the workflow disabled until it is explicitly approved.

Deploy sandbox infrastructure and resolvers with:

```bash
npm run deploy:lifecycle:sandbox
npm run configure:lifecycle:sandbox
```

Production requires the existing explicit confirmation environment variable. Deploying the stack does not enable campaign sends.

```bash
CONFIRM_PRODUCTION=deploy-existing-yahtzee-production npm run deploy:lifecycle:production
CONFIRM_PRODUCTION=deploy-existing-yahtzee-production npm run configure:lifecycle:production
```

Only enable a campaign after reviewing a dry-run evaluation in CloudWatch. Keep sandbox recipients on an explicit test allow-list before enabling real sends.
