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
const expoTokenPattern = /^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/;
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

async function listAllUsers() {
  const users = [];
  let PaginationToken;
  do {
    const result = await cognito.send(new ListUsersCommand({ UserPoolId: pool, Limit: 60, PaginationToken }));
    users.push(...(result.Users ?? []));
    PaginationToken = result.PaginationToken;
  } while (PaginationToken);
  return users;
}

async function adminDashboard(claims) {
  if (!isAdmin(claims)) throw new Error('Admin access required');
  const [profiles, results, cognitoUsers, notificationItems] = await Promise.all([
    scanAll(table, { FilterExpression: 'begins_with(pk, :prefix)', ExpressionAttributeValues: { ':prefix': s('USER#') } }),
    scanAll(gameResultTable, { ProjectionExpression: 'id, userId, username, #mode, score, completedAt, yahtzeeCount, earnedUpperBonus', ExpressionAttributeNames: { '#mode': 'mode' } }),
    listAllUsers(),
    scanAll(table, { FilterExpression: 'begins_with(pk, :prefix)', ExpressionAttributeValues: { ':prefix': s('NOTIFICATION#CUSTOM#') } }),
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
  const profileByUser = new Map(profiles.map((item) => [item.userId?.S, item]));
  const resultsByUser = new Map();
  for (const result of results) {
    const userId = result.userId?.S;
    if (!userId) continue;
    const userResults = resultsByUser.get(userId) ?? [];
    userResults.push(result);
    resultsByUser.set(userId, userResults);
  }
  const users = cognitoUsers.map((user) => {
    const attributes = Object.fromEntries((user.Attributes ?? []).map((attribute) => [attribute.Name, attribute.Value ?? '']));
    const userId = attributes.sub ?? user.Username ?? '';
    const profile = profileByUser.get(userId);
    const games = (resultsByUser.get(userId) ?? []).sort((a, b) => String(b.completedAt?.S ?? '').localeCompare(String(a.completedAt?.S ?? '')));
    const scores = games.map((game) => Number(game.score?.N ?? 0));
    return {
      userId,
      email: attributes.email ?? '',
      emailVerified: attributes.email_verified === 'true',
      username: profile?.username?.S ?? attributes.preferred_username ?? '',
      firstName: profile?.firstName?.S ?? attributes.given_name ?? '',
      lastName: profile?.lastName?.S ?? attributes.family_name ?? '',
      status: user.UserStatus ?? 'UNKNOWN',
      enabled: user.Enabled !== false,
      profileComplete: Boolean(profile?.username?.S),
      signedUpAt: user.UserCreateDate?.toISOString() ?? null,
      accountUpdatedAt: user.UserLastModifiedDate?.toISOString() ?? null,
      lastPlayedAt: games[0]?.completedAt?.S ?? null,
      gamesPlayed: games.length,
      soloGames: games.filter((game) => game.mode?.S === 'SOLO').length,
      dailyGames: games.filter((game) => game.mode?.S === 'DAILY').length,
      bestScore: scores.length ? Math.max(...scores) : null,
      averageScore: scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : null,
      pushNotificationsEnabled: profile?.pushNotificationsEnabled?.BOOL === true && expoTokenPattern.test(profile?.expoPushToken?.S ?? ''),
    };
  }).sort((a, b) => String(b.lastPlayedAt ?? b.signedUpAt ?? '').localeCompare(String(a.lastPlayedAt ?? a.signedUpAt ?? '')));
  const recentSubmissions = [...results].sort((a, b) => String(b.completedAt?.S ?? '').localeCompare(String(a.completedAt?.S ?? ''))).slice(0, 50).map((result) => ({
    id: result.id?.S ?? '', userId: result.userId?.S ?? '', username: result.username?.S ?? '', mode: result.mode?.S ?? '', score: Number(result.score?.N ?? 0), completedAt: result.completedAt?.S ?? '',
  }));
  const notificationHistory = notificationItems.sort((a, b) => String(b.sentAt?.S ?? '').localeCompare(String(a.sentAt?.S ?? ''))).slice(0, 100).map((item) => ({
    id: item.pk?.S ?? '', title: item.title?.S ?? '', body: item.body?.S ?? '', sentAt: item.sentAt?.S ?? '',
    audience: item.audience?.S ?? 'all', selectedCount: Number(item.selectedCount?.N ?? 0), audienceCount: Number(item.audienceCount?.N ?? 0),
    sentCount: Number(item.sentCount?.N ?? 0), failedCount: Number(item.failedCount?.N ?? 0), requestedBy: item.requestedBy?.S ?? '',
  }));
  return {
    totalUsers: cognitoUsers.length,
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
    dailyActivity,
    users,
    recentSubmissions: { scores: recentSubmissions, notifications: notificationHistory },
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
    pushNotificationsEnabled: item.pushNotificationsEnabled?.BOOL ?? false,
    expoPushToken: item.expoPushToken?.S ?? '',
  } : null;
}

async function pushToExpo(messages) {
  let sentCount = 0;
  let failedCount = 0;
  for (let index = 0; index < messages.length; index += 100) {
    const batch = messages.slice(index, index + 100);
    try {
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { accept: 'application/json', 'accept-encoding': 'gzip, deflate', 'content-type': 'application/json' },
        body: JSON.stringify(batch),
      });
      if (!response.ok) throw new Error(`Expo push request failed with HTTP ${response.status}`);
      const payload = await response.json();
      const tickets = Array.isArray(payload?.data) ? payload.data : [payload?.data];
      for (const ticket of tickets) ticket?.status === 'ok' ? sentCount += 1 : failedCount += 1;
    } catch (error) {
      console.error('Expo push delivery failed', { message: error instanceof Error ? error.message : String(error), batchSize: batch.length });
      failedCount += batch.length;
    }
  }
  return { sentCount, failedCount };
}

async function notificationProfiles(userIds) {
  const selected = userIds?.length ? new Set(userIds.map(String)) : null;
  const profiles = await scanAll(table, {
    FilterExpression: 'begins_with(pk, :prefix) AND pushNotificationsEnabled = :enabled',
    ExpressionAttributeValues: { ':prefix': s('USER#'), ':enabled': { BOOL: true } },
  });
  return profiles.filter((profile) => (!selected || selected.has(profile.userId?.S)) && expoTokenPattern.test(profile.expoPushToken?.S ?? ''));
}

async function sendAdminNotification(claims, args) {
  if (!isAdmin(claims)) throw new Error('Admin access required');
  const title = clean(args.title, 60);
  const body = clean(args.body, 220);
  if (!title || !body) throw new Error('A notification title and message are required.');
  const userIds = Array.isArray(args.userIds) ? [...new Set(args.userIds.map((id) => clean(id, 80)).filter(Boolean))] : [];
  if (userIds.length > 500) throw new Error('Select no more than 500 users at once.');
  const profiles = await notificationProfiles(userIds);
  const delivered = await pushToExpo(profiles.map((profile) => ({
    to: profile.expoPushToken.S,
    sound: 'default',
    title,
    body,
    data: { destination: 'stats', notificationType: 'admin' },
  })));
  const sentAt = new Date().toISOString();
  await db.send(new PutItemCommand({ TableName: table, Item: {
    pk: s(`NOTIFICATION#CUSTOM#${sentAt}#${claims.sub}`), title: s(title), body: s(body), sentAt: s(sentAt), requestedBy: s(claims.sub),
    audience: s(userIds.length ? 'selected' : 'all'), selectedCount: { N: String(userIds.length) }, audienceCount: { N: String(profiles.length) },
    sentCount: { N: String(delivered.sentCount) }, failedCount: { N: String(delivered.failedCount) },
  } }));
  console.info('Admin notification complete', { requestedBy: claims.sub, selectedUsers: userIds.length || 'all', audienceCount: profiles.length, ...delivered });
  return { audienceCount: profiles.length, ...delivered };
}

function londonDateParts(date = new Date()) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

async function sendDailyWinnerNotifications(now = new Date()) {
  const london = londonDateParts(now);
  if (Number(london.hour) !== 10) return { skipped: true, reason: 'Outside the 10am Europe/London window' };
  const yesterdayParts = londonDateParts(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const challengeDate = `${yesterdayParts.year}-${yesterdayParts.month}-${yesterdayParts.day}`;
  const markerKey = `NOTIFICATION#DAILY_WINNERS#${challengeDate}`;
  try {
    await db.send(new PutItemCommand({
      TableName: table,
      Item: { pk: s(markerKey), createdAt: s(now.toISOString()), expiresAt: { N: String(Math.floor(now.getTime() / 1000) + 45 * 86400) } },
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') return { skipped: true, reason: 'Already sent', challengeDate };
    throw error;
  }

  const results = await scanAll(gameResultTable, {
    FilterExpression: '#mode = :daily AND challengeDate = :date',
    ExpressionAttributeNames: { '#mode': 'mode' },
    ExpressionAttributeValues: { ':daily': s('DAILY'), ':date': s(challengeDate) },
    ProjectionExpression: 'userId, score, completedAt',
  });
  results.sort((a, b) => Number(b.score?.N ?? 0) - Number(a.score?.N ?? 0) || String(a.completedAt?.S ?? '').localeCompare(String(b.completedAt?.S ?? '')));
  const winners = results.slice(0, 3);
  const profiles = await notificationProfiles(winners.map((winner) => winner.userId?.S).filter(Boolean));
  const profileByUser = new Map(profiles.map((profile) => [profile.userId?.S, profile]));
  const messages = winners.flatMap((winner, index) => {
    const profile = profileByUser.get(winner.userId?.S);
    return profile ? [{
      to: profile.expoPushToken.S,
      sound: 'default',
      title: `You finished #${index + 1} in the Daily Challenge!`,
      body: `Your ${challengeDate} score of ${Number(winner.score?.N ?? 0)} earned a top-three finish.`,
      data: { destination: 'stats', notificationType: 'daily-result', challengeDate, rank: index + 1 },
    }] : [];
  });
  const delivered = await pushToExpo(messages);
  console.info('Daily winner notifications complete', { challengeDate, winners: winners.length, audienceCount: messages.length, ...delivered });
  return { challengeDate, audienceCount: messages.length, ...delivered };
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
  if (event?.source === 'yahtzee.daily-winner-notifications') return await sendDailyWinnerNotifications();
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
  if (field === 'sendAdminNotification') return await sendAdminNotification(claims, event.args ?? {});
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
      pushNotificationsEnabled: false,
      expoPushToken: '',
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
      pushNotificationsEnabled: { BOOL: current.pushNotificationsEnabled }, ...(current.expoPushToken ? { expoPushToken: s(current.expoPushToken) } : {}),
    } } }] }));
    return { ...profile, role: isAdmin(claims) ? 'ADMIN' : 'PLAYER' };
  }
  if (field === 'updateMyPushNotifications') {
    const current = await getProfile(sub);
    if (!current) throw new Error('Create your profile before enabling notifications.');
    const enabled = Boolean(event.args.enabled);
    const token = clean(event.args.expoPushToken, 220);
    if (enabled && !expoTokenPattern.test(token || current.expoPushToken)) throw new Error('A valid device notification token is required.');
    const profile = { ...current, pushNotificationsEnabled: enabled, expoPushToken: token || current.expoPushToken };
    await db.send(new PutItemCommand({ TableName: table, Item: {
      pk: s(profileKey(sub)), userId: s(sub), username: s(profile.username), usernameNormalised: s(normalise(profile.username)), firstName: s(profile.firstName), lastName: s(profile.lastName),
      scoreSuggestionsEnabled: { BOOL: profile.scoreSuggestionsEnabled }, dailyReminderEnabled: { BOOL: profile.dailyReminderEnabled }, dailyReminderHour: { N: String(profile.dailyReminderHour) },
      pushNotificationsEnabled: { BOOL: profile.pushNotificationsEnabled }, ...(profile.expoPushToken ? { expoPushToken: s(profile.expoPushToken) } : {}),
    } }));
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
      pushNotificationsEnabled: { BOOL: current?.pushNotificationsEnabled ?? false }, ...(current?.expoPushToken ? { expoPushToken: s(current.expoPushToken) } : {}),
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
  return { userId: sub, username, firstName, lastName, scoreSuggestionsEnabled: current?.scoreSuggestionsEnabled ?? true, dailyReminderEnabled: current?.dailyReminderEnabled ?? false, dailyReminderHour: current?.dailyReminderHour ?? 19, pushNotificationsEnabled: current?.pushNotificationsEnabled ?? false, expoPushToken: current?.expoPushToken ?? '', role: isAdmin(claims) ? 'ADMIN' : 'PLAYER' };
};
