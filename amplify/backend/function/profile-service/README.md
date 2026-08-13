# Profile service

Source for the `YahtzeeProfileService` Lambda used by the custom AppSync profile resolvers.

`updateMyProfile` reserves the unique username, updates private profile fields and Cognito attributes, then propagates a changed public username to existing score records owned by the same Cognito `sub`.

The function uses the AWS SDK supplied by the Node.js Lambda runtime. Its environment requires `PROFILE_TABLE`, `SCORE_TABLE`, `GAME_RESULT_TABLE`, and `USER_POOL_ID`. `GAME_RESULT_TABLE` is created by the V2 GraphQL deployment and must be added to the Lambda environment and IAM policy before releasing V2 clients.

Daily Challenge round standings are stored as expiring `DAILY#...` records in `PROFILE_TABLE`. The `expiresAt` attribute is set 45 days ahead; enable DynamoDB TTL for that attribute so historical round-standing records are removed automatically. The AppSync `submitDailyRoundProgress` mutation invokes this Lambda and returns the authenticated player's rank among users who have reached the same round on the same local challenge date.

Remote app notifications store an Expo push token only after the player opts
in. Admin broadcasts can target every opted-in profile or selected user IDs.
The `yahtzee.daily-winner-notifications` scheduled source sends the previous
Daily Challenge's top three their finishing position at 10:00 Europe/London.
Configure it with `node scripts/configure-daily-winner-notifications.mjs`.
The two AppSync operations use the existing manually managed `ProfileService`
data source; wire them after a schema push with
`node scripts/configure-notification-resolvers.mjs sandbox` (or production
with the standard confirmation variable).
