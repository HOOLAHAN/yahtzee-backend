# Profile service

The canonical deployed Lambda source is
`amplify/backend/function/profile-service/handler.mjs`. The files in this
directory document the manually managed AWS resources and IAM policy.

`YahtzeeProfileService` backs the profile operations plus
`updateMyPreferences` and `submitDailyRoundProgress`. The latter stores one
expiring round-standing snapshot per authenticated player, challenge date and round.

Usernames are claimed case-insensitively in the `YahtzeeUserProfiles` DynamoDB
table. Profile writes require Cognito user-pool authentication. First name and
surname are returned only by authenticated profile operations and are never
part of the public leaderboard schema.

V2 also requires `GAME_RESULT_TABLE`. Username changes propagate to this table,
and account deletion removes its completion records. Grant the Lambda Scan and
BatchWriteItem access to the deployed `GameResult` table before releasing V2.

`lambda-policy.json` records the table and Cognito permissions required by the
function. DynamoDB transactions still require the corresponding item-level
`PutItem` and `DeleteItem` permissions.

Account deletion also scans for and removes leaderboard rows owned by the
authenticated Cognito `sub`, before the client deletes the Cognito user.

The `YahtzeeUserProfiles` table has DynamoDB TTL enabled on `expiresAt`.
Ordinary profile and username records do not contain that attribute and are
not affected; Daily Challenge round-standing snapshots expire after 45 days.

The same Lambda accepts the scheduled EventBridge source
`yahtzee.account-cleanup`. It deletes only Cognito users that are still
`UNCONFIRMED` after 14 days (configurable with
`UNCONFIRMED_RETENTION_DAYS`). Verified users and DynamoDB profile/score data
are never included. The Lambda role therefore also needs `ListUsers` and
`AdminDeleteUser` on the environment's user pool. Configure one daily
EventBridge invocation for each environment after applying the documented IAM
policy.
