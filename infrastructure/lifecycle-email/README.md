# Lifecycle email service

Consent-first lifecycle email support for Yahtzee Hub. The stack creates an isolated state table, Lambda, daily evaluator, SES event consumer, and AppSync invocation role.

All campaign switches default to `false` and `DRY_RUN` defaults to `true`. The incomplete-signup campaign is deliberately not implemented until its legal basis and wording are approved.

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

