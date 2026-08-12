import { CognitoIdentityProviderClient, AdminDeleteUserCommand, AdminUpdateUserAttributesCommand, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { BatchWriteItemCommand, DynamoDBClient, GetItemCommand, PutItemCommand, ScanCommand, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';

const db = new DynamoDBClient({});
const cognito = new CognitoIdentityProviderClient({});
const table = process.env.PROFILE_TABLE;
const pool = process.env.USER_POOL_ID;
const scoreTable = process.env.SCORE_TABLE;
const gameResultTable = process.env.GAME_RESULT_TABLE;
const s = (value) => ({ S: value });
const clean = (value, max = 50) => String(value ?? '').trim().slice(0, max);
const normalise = (value) => clean(value, 20).toLowerCase();
const profileKey = (sub) => `USER#${sub}`;
const usernameKey = (name) => `USERNAME#${normalise(name)}`;
const dailyRoundPrefix = (date, round) => `DAILY#${date}#ROUND#${String(round).padStart(2, '0')}#`;
const isAdmin = (claims) => {
  const groups = claims?.['cognito:groups'];
  return Array.isArray(groups) ? groups.includes('Admin') : String(groups ?? '').split(',').some((group) => group.trim() === 'Admin');
};

async function scanAll(TableName, options = {}) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const result = await db.send(new ScanCommand({ TableName, ...options, ExclusiveStartKey }));
    items.push(...(result.Items ?? []));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function adminDashboard(claims) {
  if (!isAdmin(claims)) throw new Error('Admin access required');
  const [profiles, results] = await Promise.all([
    scanAll(table, { FilterExpression: 'begins_with(pk, :prefix)', ExpressionAttributeValues: { ':prefix': s('USER#') }, ProjectionExpression: 'pk' }),
    scanAll(gameResultTable, { ProjectionExpression: 'userId, #mode, score, completedAt, yahtzeeCount, earnedUpperBonus', ExpressionAttributeNames: { '#mode': 'mode' } }),
  ]);
  const now = new Date();
  const startOfToday = new Date(now); startOfToday.setUTCHours(0, 0, 0, 0);
  const daysAgo = (days) => new Date(now.getTime() - days * 86400000);
  const last7 = daysAgo(7); const last30 = daysAgo(30);
  const completedAt = (item) => new Date(item.completedAt?.S ?? 0);
  const recent7 = results.filter((item) => completedAt(item) >= last7);
  const recent30 = results.filter((item) => completedAt(item) >= last30);
  const dailyActivity = Array.from({ length: 14 }, (_, index) => {
    const date = new Date(startOfToday); date.setUTCDate(date.getUTCDate() - (13 - index));
    const key = date.toISOString().slice(0, 10);
    const games = results.filter((item) => item.completedAt?.S?.slice(0, 10) === key);
    return { date: key, games: games.length, players: new Set(games.map((item) => item.userId?.S).filter(Boolean)).size };
  });
  return {
    totalUsers: profiles.length,
    completedGames: results.length,
    soloGames: results.filter((item) => item.mode?.S === 'SOLO').length,
    dailyGames: results.filter((item) => item.mode?.S === 'DAILY').length,
    gamesToday: results.filter((item) => completedAt(item) >= startOfToday).length,
    gamesLast7Days: recent7.length,
    gamesLast30Days: recent30.length,
    activeUsersLast7Days: new Set(recent7.map((item) => item.userId?.S).filter(Boolean)).size,
    activeUsersLast30Days: new Set(recent30.map((item) => item.userId?.S).filter(Boolean)).size,
    averageScore: results.length ? Math.round(results.reduce((sum, item) => sum + Number(item.score?.N ?? 0), 0) / results.length) : 0,
    yahtzeesRolled: results.reduce((sum, item) => sum + Number(item.yahtzeeCount?.N ?? 0), 0),
    upperBonusesEarned: results.filter((item) => item.earnedUpperBonus?.BOOL).length,
    generatedAt: now.toISOString(),
    dailyActivity: JSON.stringify(dailyActivity),
  };
}
const unconfirmedRetentionDays = Math.max(7, Number(process.env.UNCONFIRMED_RETENTION_DAYS ?? 14));

async function cleanupUnconfirmedUsers() {
  if (!pool) throw new Error('USER_POOL_ID is required for unconfirmed-user cleanup.');
  const cutoff = Date.now() - unconfirmedRetentionDays * 24 * 60 * 60 * 1000;
  let paginationToken;
  let scanned = 0;
  let deleted = 0;
  do {
    const result = await cognito.send(new ListUsersCommand({
      UserPoolId: pool,
      Filter: 'cognito:user_status = "UNCONFIRMED"',
      Limit: 60,
      PaginationToken: paginationToken,
    }));
    for (const user of result.Users ?? []) {
      scanned += 1;
      if (user.Username && user.UserCreateDate && user.UserCreateDate.getTime() < cutoff) {
        await cognito.send(new AdminDeleteUserCommand({ UserPoolId: pool, Username: user.Username }));
        deleted += 1;
      }
    }
    paginationToken = result.PaginationToken;
  } while (paginationToken);
  console.info('Unconfirmed-user cleanup complete', { scanned, deleted, retentionDays: unconfirmedRetentionDays });
  return { scanned, deleted, retentionDays: unconfirmedRetentionDays };
}

async function getProfile(sub) {
  const result = await db.send(new GetItemCommand({
    TableName: table,
    Key: { pk: s(profileKey(sub)) },
    ConsistentRead: true,
  }));
  const item = result.Item;
  return item ? {
    userId: sub,
    username: item.username.S,
    firstName: item.firstName?.S ?? '',
    lastName: item.lastName?.S ?? '',
    scoreSuggestionsEnabled: item.scoreSuggestionsEnabled?.BOOL ?? true,
    dailyReminderEnabled: item.dailyReminderEnabled?.BOOL ?? false,
    dailyReminderHour: Number(item.dailyReminderHour?.N ?? 19),
  } : null;
}

async function writeAll(requestItems) {
  let pending = requestItems;
  do {
    const result = await db.send(new BatchWriteItemCommand({ RequestItems: pending }));
    pending = result.UnprocessedItems ?? {};
  } while (Object.values(pending).some((requests) => requests.length));
}

async function renameScores(sub, username) {
  if (!scoreTable) return;
  let startKey;
  do {
    const result = await db.send(new ScanCommand({
      TableName: scoreTable,
      FilterExpression: 'userId = :sub',
      ExpressionAttributeValues: { ':sub': s(sub) },
      ExclusiveStartKey: startKey,
    }));
    const items = (result.Items ?? []).map((item) => ({ ...item, username: s(username) }));
    for (let index = 0; index < items.length; index += 25) {
      await writeAll({
        [scoreTable]: items.slice(index, index + 25).map((item) => ({ PutRequest: { Item: item } })),
      });
    }
    startKey = result.LastEvaluatedKey;
  } while (startKey);
}

async function renameGameResults(sub, username) {
  if (!gameResultTable) return;
  let startKey;
  do {
    const result = await db.send(new ScanCommand({ TableName: gameResultTable, FilterExpression: 'userId = :sub', ExpressionAttributeValues: { ':sub': s(sub) }, ExclusiveStartKey: startKey }));
    const items = (result.Items ?? []).map((item) => ({ ...item, username: s(username) }));
    for (let index = 0; index < items.length; index += 25) await writeAll({ [gameResultTable]: items.slice(index, index + 25).map((item) => ({ PutRequest: { Item: item } })) });
    startKey = result.LastEvaluatedKey;
  } while (startKey);
}

async function deleteScores(sub) {
  if (!scoreTable) return;
  let startKey;
  do {
    const result = await db.send(new ScanCommand({
      TableName: scoreTable,
      FilterExpression: 'userId = :sub',
      ExpressionAttributeValues: { ':sub': s(sub) },
      ProjectionExpression: 'id',
      ExclusiveStartKey: startKey,
    }));
    const ids = (result.Items ?? []).map((item) => item.id).filter(Boolean);
    for (let index = 0; index < ids.length; index += 25) {
      await writeAll({
        [scoreTable]: ids.slice(index, index + 25).map((id) => ({ DeleteRequest: { Key: { id } } })),
      });
    }
    startKey = result.LastEvaluatedKey;
  } while (startKey);
}

async function deleteGameResults(sub) {
  if (!gameResultTable) return;
  let startKey;
  do {
    const result = await db.send(new ScanCommand({ TableName: gameResultTable, FilterExpression: 'userId = :sub', ExpressionAttributeValues: { ':sub': s(sub) }, ProjectionExpression: 'id', ExclusiveStartKey: startKey }));
    const ids = (result.Items ?? []).map((item) => item.id).filter(Boolean);
    for (let index = 0; index < ids.length; index += 25) {
      await writeAll({
        [gameResultTable]: ids.slice(index, index + 25).map((id) => ({
          DeleteRequest: { Key: { id } },
        })),
      });
    }
    startKey = result.LastEvaluatedKey;
  } while (startKey);
}

async function deleteDailyProgress(sub) {
  let startKey;
  do {
    const result = await db.send(new ScanCommand({
      TableName: table,
      FilterExpression: 'begins_with(pk, :prefix) AND userId = :sub',
      ExpressionAttributeValues: { ':prefix': s('DAILY#'), ':sub': s(sub) },
      ProjectionExpression: 'pk',
      ExclusiveStartKey: startKey,
    }));
    const keys = (result.Items ?? []).map((item) => item.pk).filter(Boolean);
    for (let index = 0; index < keys.length; index += 25) {
      await writeAll({ [table]: keys.slice(index, index + 25).map((pk) => ({ DeleteRequest: { Key: { pk } } })) });
    }
    startKey = result.LastEvaluatedKey;
  } while (startKey);
}

async function submitDailyRoundProgress(sub, challengeDate, roundValue, scoreValue) {
  const date = clean(challengeDate, 10);
  const round = Number(roundValue);
  const score = Number(scoreValue);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('A valid challenge date is required.');
  if (!Number.isInteger(round) || round < 1 || round > 13) throw new Error('Round must be between 1 and 13.');
  if (!Number.isInteger(score) || score < 0 || score > 375) throw new Error('Score is outside the valid range.');

  const prefix = dailyRoundPrefix(date, round);
  const now = new Date();
  const expiresAt = Math.floor(now.getTime() / 1000) + 45 * 24 * 60 * 60;
  await db.send(new PutItemCommand({
    TableName: table,
    Item: {
      pk: s(`${prefix}${sub}`),
      userId: s(sub),
      challengeDate: s(date),
      round: { N: String(round) },
      score: { N: String(score) },
      updatedAt: s(now.toISOString()),
      expiresAt: { N: String(expiresAt) },
    },
  }));

  const scores = [];
  let startKey;
  do {
    const result = await db.send(new ScanCommand({
      TableName: table,
      FilterExpression: 'begins_with(pk, :prefix)',
      ExpressionAttributeValues: { ':prefix': s(prefix) },
      ProjectionExpression: 'score',
      ConsistentRead: true,
      ExclusiveStartKey: startKey,
    }));
    for (const item of result.Items ?? []) if (item.score?.N !== undefined) scores.push(Number(item.score.N));
    startKey = result.LastEvaluatedKey;
  } while (startKey);

  const rank = 1 + scores.filter((otherScore) => otherScore > score).length;
  const playerCount = scores.length;
  return {
    challengeDate: date,
    round,
    score,
    rank,
    playerCount,
    percentile: Math.max(1, Math.ceil((rank / Math.max(1, playerCount)) * 100)),
  };
}

export const handler = async (event) => {
  if (event?.source === 'yahtzee.account-cleanup') return await cleanupUnconfirmedUsers();
  const field = event.field;
  if (field === 'usernameAvailable') {
    const username = clean(event.args.username, 20);
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return false;
    const result = await db.send(new GetItemCommand({
      TableName: table,
      Key: { pk: s(usernameKey(username)) },
      ConsistentRead: true,
    }));
    return !result.Item;
  }

  const claims = event.identity?.claims;
  const sub = claims?.sub;
  if (!sub) throw new Error('Authentication required');
  if (field === 'adminDashboard') return await adminDashboard(claims);
  if (field === 'submitDailyRoundProgress') {
    return await submitDailyRoundProgress(sub, event.args.challengeDate, event.args.round, event.args.score);
  }
  if (field === 'myProfile') {
    const profile = await getProfile(sub) ?? {
      userId: sub,
      username: claims.preferred_username ?? '',
      firstName: claims.given_name ?? '',
      lastName: claims.family_name ?? '',
      scoreSuggestionsEnabled: true,
      dailyReminderEnabled: false,
      dailyReminderHour: 19,
    };
    return { ...profile, role: isAdmin(claims) ? 'ADMIN' : 'PLAYER' };
  }
  if (field === 'deleteMyProfile') {
    const current = await getProfile(sub);
    await deleteScores(sub);
    await deleteGameResults(sub);
    await deleteDailyProgress(sub);
    if (current) {
      await db.send(new TransactWriteItemsCommand({ TransactItems: [
        { Delete: { TableName: table, Key: { pk: s(profileKey(sub)) } } },
        { Delete: {
          TableName: table,
          Key: { pk: s(usernameKey(current.username)) },
          ConditionExpression: 'userId = :sub',
          ExpressionAttributeValues: { ':sub': s(sub) },
        } },
      ] }));
    }
    return true;
  }
  if (field === 'updateMyPreferences') {
    const current = await getProfile(sub);
    if (!current) throw new Error('Create your profile before saving preferences.');
    const hour = Math.max(0, Math.min(23, Number(event.args.dailyReminderHour)));
    const profile = { ...current, scoreSuggestionsEnabled: Boolean(event.args.scoreSuggestionsEnabled), dailyReminderEnabled: Boolean(event.args.dailyReminderEnabled), dailyReminderHour: hour };
    await db.send(new TransactWriteItemsCommand({ TransactItems: [{ Put: { TableName: table, Item: {
      pk: s(profileKey(sub)), userId: s(sub), username: s(profile.username), usernameNormalised: s(normalise(profile.username)), firstName: s(profile.firstName), lastName: s(profile.lastName),
      scoreSuggestionsEnabled: { BOOL: profile.scoreSuggestionsEnabled }, dailyReminderEnabled: { BOOL: profile.dailyReminderEnabled }, dailyReminderHour: { N: String(profile.dailyReminderHour) },
    } } }] }));
    return { ...profile, role: isAdmin(claims) ? 'ADMIN' : 'PLAYER' };
  }
  if (field !== 'updateMyProfile') throw new Error('Unsupported operation');

  const username = clean(event.args.username, 20);
  const firstName = clean(event.args.firstName);
  const lastName = clean(event.args.lastName);
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw new Error('Username must be 3–20 letters, numbers or underscores.');
  if (!firstName || !lastName) throw new Error('First name and surname are required.');

  const current = await getProfile(sub);
  const items = [
    { Put: {
      TableName: table,
      Item: { pk: s(usernameKey(username)), userId: s(sub) },
      ConditionExpression: 'attribute_not_exists(pk) OR userId = :sub',
      ExpressionAttributeValues: { ':sub': s(sub) },
    } },
    { Put: { TableName: table, Item: {
      pk: s(profileKey(sub)), userId: s(sub), username: s(username),
      usernameNormalised: s(normalise(username)), firstName: s(firstName), lastName: s(lastName),
      scoreSuggestionsEnabled: { BOOL: current?.scoreSuggestionsEnabled ?? true }, dailyReminderEnabled: { BOOL: current?.dailyReminderEnabled ?? false }, dailyReminderHour: { N: String(current?.dailyReminderHour ?? 19) },
    } } },
  ];
  if (current && normalise(current.username) !== normalise(username)) {
    items.push({ Delete: {
      TableName: table,
      Key: { pk: s(usernameKey(current.username)) },
      ConditionExpression: 'userId = :sub',
      ExpressionAttributeValues: { ':sub': s(sub) },
    } });
  }
  try {
    await db.send(new TransactWriteItemsCommand({ TransactItems: items }));
  } catch (error) {
    if (error.name === 'TransactionCanceledException') throw new Error('That username is already taken.');
    throw error;
  }

  await cognito.send(new AdminUpdateUserAttributesCommand({
    UserPoolId: pool,
    Username: claims['cognito:username'],
    UserAttributes: [
      { Name: 'preferred_username', Value: username },
      { Name: 'given_name', Value: firstName },
      { Name: 'family_name', Value: lastName },
    ],
  }));

  if (!current || current.username !== username) await Promise.all([renameScores(sub, username), renameGameResults(sub, username)]);
  return { userId: sub, username, firstName, lastName, scoreSuggestionsEnabled: current?.scoreSuggestionsEnabled ?? true, dailyReminderEnabled: current?.dailyReminderEnabled ?? false, dailyReminderHour: current?.dailyReminderHour ?? 19, role: isAdmin(claims) ? 'ADMIN' : 'PLAYER' };
};
