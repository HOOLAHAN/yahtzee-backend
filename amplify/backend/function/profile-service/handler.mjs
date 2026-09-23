import { CognitoIdentityProviderClient, AdminDeleteUserCommand, AdminUpdateUserAttributesCommand, ListUsersCommand, ListUsersInGroupCommand } from '@aws-sdk/client-cognito-identity-provider';
import { BatchWriteItemCommand, DynamoDBClient, GetItemCommand, PutItemCommand, ScanCommand, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import { randomInt, randomUUID } from 'node:crypto';

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
const liveGameKey = (id) => `LIVE#${id}`;
const liveCodeKey = (code) => `LIVE_CODE#${code}`;
const liveCategories = ['Ones', 'Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Three of a Kind', 'Four of a Kind', 'Full House', 'Small Straight', 'Large Straight', 'Yahtzee', 'Chance'];
const liveUpperCategories = liveCategories.slice(0, 6);
const lifecycleActions = new Set(['STARTED', 'RESET', 'MODE_SWITCH', 'REMOTE_EXIT', 'COMPLETED']);
const lifecycleModes = new Set(['SOLO', 'DAILY', 'COMPUTER', 'PASS', 'REAL', 'REMOTE']);
const lifecyclePlatforms = new Set(['WEB', 'IOS', 'ANDROID']);
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

async function listGroupUsernames(GroupName) {
  const usernames = new Set();
  let NextToken;
  do {
    const result = await cognito.send(new ListUsersInGroupCommand({ UserPoolId: pool, GroupName, Limit: 60, NextToken }));
    for (const user of result.Users ?? []) if (user.Username) usernames.add(user.Username);
    NextToken = result.NextToken;
  } while (NextToken);
  return usernames;
}

async function adminDashboard(claims) {
  if (!isAdmin(claims)) throw new Error('Admin access required');
  const [profiles, results, cognitoUsers, notificationItems, lifecycleItems, adminUsernames] = await Promise.all([
    scanAll(table, { FilterExpression: 'begins_with(pk, :prefix)', ExpressionAttributeValues: { ':prefix': s('USER#') } }),
    scanAll(gameResultTable, { ProjectionExpression: 'id, userId, username, #mode, score, completedAt, yahtzeeCount, earnedUpperBonus, #session', ExpressionAttributeNames: { '#mode': 'mode', '#session': 'session' } }),
    listAllUsers(),
    scanAll(table, { FilterExpression: 'begins_with(pk, :prefix)', ExpressionAttributeValues: { ':prefix': s('NOTIFICATION#CUSTOM#') } }),
    scanAll(table, { FilterExpression: 'begins_with(pk, :prefix)', ExpressionAttributeValues: { ':prefix': s('GAME_EVENT#') } }),
    listGroupUsernames('Admin'),
  ]);
  const now = new Date();
  const startOfToday = new Date(now); startOfToday.setUTCHours(0, 0, 0, 0);
  const daysAgo = (days) => new Date(now.getTime() - days * 86400000);
  const last7 = daysAgo(7); const last30 = daysAgo(30);
  const completedAt = (item) => new Date(item.completedAt?.S ?? 0);
  const sessionFor = (item) => { try { let value = item.session?.S; for (let pass = 0; pass < 2 && typeof value === 'string'; pass += 1) value = JSON.parse(value); return value && typeof value === 'object' ? value : {}; } catch { return {}; } };
  const remoteResults = results.filter((item) => item.mode?.S === 'REMOTE');
  const lifecycleEvents = lifecycleItems.map((item) => ({
    gameId: item.gameId?.S ?? '', userId: item.userId?.S ?? '', username: item.username?.S ?? '',
    action: item.action?.S ?? '', mode: item.mode?.S ?? '', round: Number(item.round?.N ?? 0),
    score: Number(item.score?.N ?? 0), categoriesFilled: Number(item.categoriesFilled?.N ?? 0),
    platform: item.platform?.S ?? '', occurredAt: item.occurredAt?.S ?? '',
  })).filter((item) => item.gameId);
  const lifecycleByGame = new Map();
  for (const item of lifecycleEvents) {
    const game = lifecycleByGame.get(item.gameId) ?? [];
    game.push(item);
    lifecycleByGame.set(item.gameId, game);
  }
  const terminalActions = new Set(['RESET', 'MODE_SWITCH', 'REMOTE_EXIT', 'COMPLETED']);
  const starts = lifecycleEvents.filter((item) => item.action === 'STARTED');
  const explicitAbandons = lifecycleEvents.filter((item) => ['RESET', 'MODE_SWITCH', 'REMOTE_EXIT'].includes(item.action));
  const staleCutoff = now.getTime() - 24 * 60 * 60 * 1000;
  const staleGames = [...lifecycleByGame.values()].filter((events) => {
    const started = events.find((item) => item.action === 'STARTED');
    return started && Date.parse(started.occurredAt) < staleCutoff && !events.some((item) => terminalActions.has(item.action));
  });
  const completedLifecycleGames = [...lifecycleByGame.values()].filter((events) => events.some((item) => item.action === 'COMPLETED')).length;
  const abandonmentByMode = [...lifecycleModes].map((mode) => {
    const modeStarts = starts.filter((item) => item.mode === mode).length;
    const abandoned = explicitAbandons.filter((item) => item.mode === mode).length;
    return { mode, starts: modeStarts, abandoned, rate: modeStarts ? Math.round(abandoned / modeStarts * 100) : 0 };
  }).filter((item) => item.starts || item.abandoned);
  const recentAbandonments = [...explicitAbandons].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, 50);
  const remoteMatchIds = new Set(remoteResults.map((item) => sessionFor(item).liveGameId).filter(Boolean));
  const recent7 = results.filter((item) => completedAt(item) >= last7);
  const recent30 = results.filter((item) => completedAt(item) >= last30);
  const completedDates = results.map((item) => Date.parse(item.completedAt?.S ?? '')).filter(Number.isFinite);
  const firstActivity = completedDates.length ? new Date(Math.min(...completedDates)) : new Date(startOfToday);
  firstActivity.setUTCHours(0, 0, 0, 0);
  const activityDayCount = Math.max(1, Math.floor((startOfToday.getTime() - firstActivity.getTime()) / 86400000) + 1);
  const dailyActivity = Array.from({ length: activityDayCount }, (_, index) => {
    const date = new Date(firstActivity); date.setUTCDate(date.getUTCDate() + index);
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
    const userLifecycle = lifecycleEvents.filter((event) => event.userId === userId).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    const userStarts = userLifecycle.filter((event) => event.action === 'STARTED');
    const userAbandons = userLifecycle.filter((event) => ['RESET', 'MODE_SWITCH', 'REMOTE_EXIT'].includes(event.action));
    const remoteGames = games.filter((game) => game.mode?.S === 'REMOTE');
    const lifecycleModeBreakdown = [...lifecycleModes].map((mode) => ({
      mode,
      starts: userStarts.filter((event) => event.mode === mode).length,
      abandons: userAbandons.filter((event) => event.mode === mode).length,
      completions: userLifecycle.filter((event) => event.mode === mode && event.action === 'COMPLETED').length,
    })).filter((item) => item.starts || item.abandons || item.completions);
    const recentGames = games.slice(0, 10).map((game) => ({
      id: game.id?.S ?? '', mode: game.mode?.S ?? '', score: Number(game.score?.N ?? 0), completedAt: game.completedAt?.S ?? '',
      yahtzeeCount: Number(game.yahtzeeCount?.N ?? 0), earnedUpperBonus: game.earnedUpperBonus?.BOOL === true,
      remoteOutcome: game.mode?.S === 'REMOTE' ? sessionFor(game).outcome ?? null : null,
      opponent: game.mode?.S === 'REMOTE' ? sessionFor(game).opponent ?? null : null,
    }));
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
      remoteGames: remoteGames.length,
      remoteWins: remoteGames.filter((game) => sessionFor(game).outcome === 'WIN').length,
      remoteDraws: remoteGames.filter((game) => sessionFor(game).outcome === 'DRAW').length,
      remoteLosses: remoteGames.filter((game) => sessionFor(game).outcome === 'LOSS').length,
      gameStarts: userStarts.length,
      abandonedGames: userAbandons.length,
      resetGames: userAbandons.filter((event) => event.action === 'RESET').length,
      modeSwitchAbandons: userAbandons.filter((event) => event.action === 'MODE_SWITCH').length,
      remoteExits: userAbandons.filter((event) => event.action === 'REMOTE_EXIT').length,
      averageAbandonRound: userAbandons.length ? Math.round(userAbandons.reduce((sum, event) => sum + event.round, 0) / userAbandons.length) : 0,
      lastAbandonedAt: userAbandons[0]?.occurredAt ?? null,
      lifecyclePlatforms: [...new Set(userLifecycle.map((event) => event.platform).filter(Boolean))],
      lifecycleModeBreakdown,
      recentAbandonments: userAbandons.slice(0, 10),
      recentGames,
      bestScore: scores.length ? Math.max(...scores) : null,
      averageScore: scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : null,
      pushNotificationsEnabled: profile?.pushNotificationsEnabled?.BOOL === true && expoTokenPattern.test(profile?.expoPushToken?.S ?? ''),
      isAdmin: adminUsernames.has(user.Username ?? ''),
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
    remoteGames: remoteResults.length,
    remoteMatches: remoteMatchIds.size || Math.ceil(remoteResults.length / 2),
    remoteWins: remoteResults.filter((item) => sessionFor(item).outcome === 'WIN').length,
    remoteDraws: Math.ceil(remoteResults.filter((item) => sessionFor(item).outcome === 'DRAW').length / 2),
    gamesToday: results.filter((item) => completedAt(item) >= startOfToday).length,
    gamesLast7Days: recent7.length,
    gamesLast30Days: recent30.length,
    activeUsersLast7Days: new Set(recent7.map((item) => item.userId?.S).filter(Boolean)).size,
    activeUsersLast30Days: new Set(recent30.map((item) => item.userId?.S).filter(Boolean)).size,
    averageScore: results.length ? Math.round(results.reduce((sum, item) => sum + Number(item.score?.N ?? 0), 0) / results.length) : 0,
    yahtzeesRolled: results.reduce((sum, item) => sum + Number(item.yahtzeeCount?.N ?? 0), 0),
    upperBonusesEarned: results.filter((item) => item.earnedUpperBonus?.BOOL).length,
    gameStarts: starts.length,
    abandonedGames: explicitAbandons.length,
    resetGames: explicitAbandons.filter((item) => item.action === 'RESET').length,
    modeSwitchAbandons: explicitAbandons.filter((item) => item.action === 'MODE_SWITCH').length,
    remoteExits: explicitAbandons.filter((item) => item.action === 'REMOTE_EXIT').length,
    staleGames: staleGames.length,
    gameCompletionRate: starts.length ? Math.round(completedLifecycleGames / starts.length * 100) : 0,
    averageAbandonRound: explicitAbandons.length ? Math.round(explicitAbandons.reduce((sum, item) => sum + item.round, 0) / explicitAbandons.length) : 0,
    abandonmentByMode,
    recentAbandonments,
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
    notifyTurns: item.notifyTurns?.BOOL ?? true,
    notifyInvites: item.notifyInvites?.BOOL ?? true,
    notifyGameUpdates: item.notifyGameUpdates?.BOOL ?? true,
    expoPushToken: item.expoPushToken?.S ?? '',
  } : null;
}

async function getProfileByUsername(rawUsername) {
  const username = clean(rawUsername, 20);
  if (!username) return null;
  const lookup = await db.send(new GetItemCommand({
    TableName: table,
    Key: { pk: s(usernameKey(username)) },
    ConsistentRead: true,
  }));
  const userId = lookup.Item?.userId?.S;
  return userId ? await getProfile(userId) : null;
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

async function notifyAdminsOfNewUser(username) {
  try {
    const adminUsers = [];
    let NextToken;
    do {
      const result = await cognito.send(new ListUsersInGroupCommand({ UserPoolId: pool, GroupName: 'Admin', Limit: 60, NextToken }));
      adminUsers.push(...(result.Users ?? []));
      NextToken = result.NextToken;
    } while (NextToken);
    const adminIds = adminUsers
      .map((user) => user.Attributes?.find((attribute) => attribute.Name === 'sub')?.Value)
      .filter(Boolean);
    if (!adminIds.length) {
      console.info('New-user admin notification skipped because the Admin group is empty', { username });
      return;
    }
    const profiles = await notificationProfiles(adminIds);
    const delivered = await pushToExpo(profiles.map((profile) => ({
      to: profile.expoPushToken.S,
      sound: 'default',
      title: 'New player signed up',
      body: `${username} has joined Yahtzee Hub.`,
      data: { destination: 'admin', notificationType: 'new-user' },
    })));
    console.info('New-user admin notification complete', { username, audienceCount: profiles.length, ...delivered });
  } catch (error) {
    // Profile creation has already succeeded. Notification delivery must never
    // make a new account appear to have failed or cause the client to retry it.
    console.error('New-user admin notification failed', { username, message: error instanceof Error ? error.message : String(error) });
  }
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

const liveCounts = (dice) => Object.values(dice.reduce((counts, die) => ({ ...counts, [die]: (counts[die] ?? 0) + 1 }), {}));
const liveIsYahtzee = (dice) => dice.length === 5 && dice.every((die) => die === dice[0]);
const liveHasStraight = (dice, length) => {
  const values = [...new Set(dice)].sort((a, b) => a - b);
  let run = 1;
  for (let index = 1; index < values.length; index += 1) {
    run = values[index] === values[index - 1] + 1 ? run + 1 : 1;
    if (run >= length) return true;
  }
  return false;
};
const liveBaseScore = (category, dice) => {
  const sum = dice.reduce((total, die) => total + die, 0);
  const counts = liveCounts(dice);
  const upperIndex = liveCategories.indexOf(category);
  if (upperIndex >= 0 && upperIndex < 6) return dice.filter((die) => die === upperIndex + 1).reduce((total, die) => total + die, 0);
  if (category === 'Three of a Kind') return counts.some((count) => count >= 3) ? sum : 0;
  if (category === 'Four of a Kind') return counts.some((count) => count >= 4) ? sum : 0;
  if (category === 'Full House') return counts.includes(3) && counts.includes(2) ? 25 : 0;
  if (category === 'Small Straight') return liveHasStraight(dice, 4) ? 30 : 0;
  if (category === 'Large Straight') return liveHasStraight(dice, 5) ? 40 : 0;
  if (category === 'Yahtzee') return counts.includes(5) ? 50 : 0;
  if (category === 'Chance') return sum;
  return 0;
};
const liveCategoryEligible = (category, dice, scores) => {
  const used = new Set(scores.map((entry) => entry.category));
  if (!liveCategories.includes(category) || used.has(category)) return false;
  const yahtzeeEntry = scores.find((entry) => entry.category === 'Yahtzee');
  if (!liveIsYahtzee(dice) || !yahtzeeEntry) return true;
  const matchingUpper = liveUpperCategories[dice[0] - 1];
  if (!used.has(matchingUpper)) return category === matchingUpper;
  const openLower = liveCategories.slice(6).some((lower) => !used.has(lower));
  return openLower ? !liveUpperCategories.includes(category) : liveUpperCategories.includes(category);
};
const liveScoreCategory = (category, dice, scores) => {
  if (!liveCategoryEligible(category, dice, scores)) throw new Error('That category is not available for this roll.');
  if (scores.some((entry) => entry.category === 'Yahtzee') && liveIsYahtzee(dice)) {
    if (category === 'Full House') return 25;
    if (category === 'Small Straight') return 30;
    if (category === 'Large Straight') return 40;
  }
  return liveBaseScore(category, dice);
};
const liveBonus = (scores, dice) => liveIsYahtzee(dice) && scores.some((entry) => entry.category === 'Yahtzee' && entry.score === 50) ? 100 : 0;
const liveUpperSubtotal = (scores) => scores.filter((entry) => liveUpperCategories.includes(entry.category)).reduce((total, entry) => total + entry.score, 0);
const liveTotal = (scores) => scores.reduce((total, entry) => total + entry.score + (entry.yahtzeeBonus ?? 0), 0) + (liveUpperSubtotal(scores) >= 63 ? 35 : 0);
const newLiveTurn = (state) => ({ ...state, dice: [1, 1, 1, 1, 1], held: [], rollsLeft: 3, hasRolled: false, selectedCategory: null });
const liveResponse = (state) => ({ ...state, dice: JSON.stringify(state.dice), held: JSON.stringify(state.held), hostScores: JSON.stringify(state.hostScores), guestScores: JSON.stringify(state.guestScores) });
const parseLiveItem = (item) => item?.state?.S ? JSON.parse(item.state.S) : null;

async function readLiveGame(id) {
  const result = await db.send(new GetItemCommand({ TableName: table, Key: { pk: s(liveGameKey(id)) }, ConsistentRead: true }));
  return { state: parseLiveItem(result.Item), version: Number(result.Item?.version?.N ?? 0) };
}

function assertLiveParticipant(state, sub) {
  if (!state || (state.hostUserId !== sub && state.guestUserId !== sub)) throw new Error('Live game not found.');
}

async function saveLiveGame(state, expectedVersion) {
  const now = new Date().toISOString();
  const next = { ...state, updatedAt: now };
  try {
    await db.send(new PutItemCommand({
      TableName: table,
      Item: { pk: s(liveGameKey(state.id)), state: s(JSON.stringify(next)), version: { N: String(expectedVersion + 1) }, expiresAt: { N: String(Math.floor(Date.now() / 1000) + 7 * 86400) } },
      ConditionExpression: 'version = :expectedVersion',
      ExpressionAttributeValues: { ':expectedVersion': { N: String(expectedVersion) } },
    }));
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') throw new Error('The game changed on the other device. Please try again.');
    throw error;
  }
  return next;
}

async function notifyLivePlayer(userId, title, body, gameId, actorUserId, category = 'update') {
  if (!userId) return;
  let profiles = await notificationProfiles([userId]);
  const flag = category === 'turn' ? 'notifyTurns' : category === 'invite' ? 'notifyInvites' : 'notifyGameUpdates';
  profiles = profiles.filter((profile) => profile[flag]?.BOOL !== false);
  if (actorUserId) {
    const actorProfile = await getProfile(actorUserId);
    const actorToken = actorProfile?.expoPushToken;
    if (actorToken) profiles = profiles.filter((profile) => profile.expoPushToken?.S !== actorToken);
  }
  if (!profiles.length) return;
  await pushToExpo(profiles.map((profile) => ({ to: profile.expoPushToken.S, sound: 'default', title, body, data: { destination: 'live-game', notificationType: 'live-game', gameId } })));
}

async function createLiveGame(sub, claims) {
  const profile = await getProfile(sub);
  const username = profile?.username || claims.preferred_username || claims.email || 'Player';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = randomUUID();
    const code = String(randomInt(0, 1000000)).padStart(6, '0');
    const now = new Date().toISOString();
    const state = { id, code, status: 'WAITING', hostUserId: sub, hostUsername: username, guestUserId: null, guestUsername: null, currentUserId: sub, round: 1, dice: [1, 1, 1, 1, 1], held: [], rollsLeft: 3, hasRolled: false, selectedCategory: null, hostScores: [], guestScores: [], winnerUserId: null, endedByUserId: null, createdAt: now, updatedAt: now };
    try {
      await db.send(new TransactWriteItemsCommand({ TransactItems: [
        { Put: { TableName: table, Item: { pk: s(liveGameKey(id)), state: s(JSON.stringify(state)), version: { N: '1' }, expiresAt: { N: String(Math.floor(Date.now() / 1000) + 7 * 86400) } }, ConditionExpression: 'attribute_not_exists(pk)' } },
        { Put: { TableName: table, Item: { pk: s(liveCodeKey(code)), gameId: s(id), expiresAt: { N: String(Math.floor(Date.now() / 1000) + 24 * 3600) } }, ConditionExpression: 'attribute_not_exists(pk)' } },
      ] }));
      return liveResponse(state);
    } catch (error) {
      if (error.name !== 'TransactionCanceledException') throw error;
    }
  }
  throw new Error('Unable to reserve a game code. Please try again.');
}

async function challengeLiveGame(sub, claims, rawUserId, rawUsername) {
  const requestedUserId = clean(rawUserId, 80);
  if (!requestedUserId) throw new Error('Choose another player to challenge.');
  const [hostProfile, directGuestProfile] = await Promise.all([getProfile(sub), getProfile(requestedUserId)]);
  const guestProfile = directGuestProfile || await getProfileByUsername(rawUsername);
  if (!guestProfile) throw new Error('That player is no longer available.');
  const guestUserId = guestProfile.userId;
  if (guestUserId === sub) throw new Error('You cannot challenge your own account.');
  const existingItems = await scanAll(table, { FilterExpression: 'begins_with(pk, :prefix)', ExpressionAttributeValues: { ':prefix': s('LIVE#') }, ProjectionExpression: '#state', ExpressionAttributeNames: { '#state': 'state' } });
  const existing = existingItems.map(parseLiveItem).find((state) => state?.status === 'INVITED' && state.hostUserId === sub && state.guestUserId === guestUserId && Date.now() - new Date(state.createdAt).getTime() <= 24 * 60 * 60 * 1000);
  if (existing) return liveResponse(existing);
  const id = randomUUID();
  const now = new Date().toISOString();
  const hostUsername = hostProfile?.username || claims.preferred_username || claims.email || 'Player';
  const state = { id, code: '', status: 'INVITED', hostUserId: sub, hostUsername, guestUserId, guestUsername: guestProfile.username, currentUserId: sub, round: 1, dice: [1, 1, 1, 1, 1], held: [], rollsLeft: 3, hasRolled: false, selectedCategory: null, hostScores: [], guestScores: [], winnerUserId: null, endedByUserId: null, createdAt: now, updatedAt: now };
  await db.send(new PutItemCommand({ TableName: table, Item: { pk: s(liveGameKey(id)), state: s(JSON.stringify(state)), version: { N: '1' }, expiresAt: { N: String(Math.floor(Date.now() / 1000) + 7 * 86400) } }, ConditionExpression: 'attribute_not_exists(pk)' }));
  try { await notifyLivePlayer(guestUserId, 'Game challenge', `${hostUsername} challenged you to a Remote Game.`, id, sub, 'invite'); } catch { /* The in-app invitation remains available if push delivery fails. */ }
  return liveResponse(state);
}

async function createLiveRematch(previous, requester) {
  if (previous.status !== 'COMPLETED' || !previous.guestUserId) throw new Error('This game cannot be replayed yet.');
  const existingItems = await scanAll(table, { FilterExpression: 'begins_with(pk, :prefix)', ExpressionAttributeValues: { ':prefix': s('LIVE#') }, ProjectionExpression: '#state', ExpressionAttributeNames: { '#state': 'state' } });
  const existing = existingItems.map(parseLiveItem).find((state) => state?.rematchOfGameId === previous.id && ['WAITING', 'ACTIVE'].includes(state.status));
  if (existing) return liveResponse(existing);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = randomUUID();
    const code = String(randomInt(0, 1000000)).padStart(6, '0');
    const now = new Date().toISOString();
    const starter = requester === previous.hostUserId ? previous.guestUserId : previous.hostUserId;
    const state = { id, code, status: 'ACTIVE', hostUserId: previous.hostUserId, hostUsername: previous.hostUsername, guestUserId: previous.guestUserId, guestUsername: previous.guestUsername, currentUserId: starter, round: 1, dice: [1, 1, 1, 1, 1], held: [], rollsLeft: 3, hasRolled: false, selectedCategory: null, hostScores: [], guestScores: [], winnerUserId: null, endedByUserId: null, rematchOfGameId: previous.id, createdAt: now, updatedAt: now };
    try {
      await db.send(new TransactWriteItemsCommand({ TransactItems: [
        { Put: { TableName: table, Item: { pk: s(liveGameKey(id)), state: s(JSON.stringify(state)), version: { N: '1' }, expiresAt: { N: String(Math.floor(Date.now() / 1000) + 7 * 86400) } }, ConditionExpression: 'attribute_not_exists(pk)' } },
        { Put: { TableName: table, Item: { pk: s(liveCodeKey(code)), gameId: s(id), expiresAt: { N: String(Math.floor(Date.now() / 1000) + 24 * 3600) } }, ConditionExpression: 'attribute_not_exists(pk)' } },
      ] }));
      const opponentId = requester === state.hostUserId ? state.guestUserId : state.hostUserId;
      try { await notifyLivePlayer(opponentId, 'Rematch ready', `${requester === state.hostUserId ? state.hostUsername : state.guestUsername} started another game.`, state.id, requester, 'invite'); } catch { /* The match is created even if push delivery is unavailable. */ }
      return liveResponse(state);
    } catch (error) {
      if (error.name !== 'TransactionCanceledException') throw error;
    }
  }
  throw new Error('Unable to start the rematch. Please try again.');
}

async function joinLiveGame(sub, claims, rawCode) {
  const code = clean(rawCode, 6);
  if (!/^\d{6}$/.test(code)) throw new Error('Enter the six-digit game code.');
  const mapping = await db.send(new GetItemCommand({ TableName: table, Key: { pk: s(liveCodeKey(code)) }, ConsistentRead: true }));
  const id = mapping.Item?.gameId?.S;
  if (!id) throw new Error('That game code was not found or has expired.');
  const current = await readLiveGame(id);
  if (!current.state || current.state.status !== 'WAITING') throw new Error('That game is no longer waiting for a player.');
  if (Date.now() - new Date(current.state.createdAt).getTime() > 24 * 60 * 60 * 1000) throw new Error('That game invitation has expired. Ask your friend to create a new one.');
  if (current.state.hostUserId === sub) throw new Error('Share this code with another signed-in player.');
  const profile = await getProfile(sub);
  const next = await saveLiveGame({ ...current.state, status: 'ACTIVE', guestUserId: sub, guestUsername: profile?.username || claims.preferred_username || claims.email || 'Player', currentUserId: current.state.hostUserId }, current.version);
    await notifyLivePlayer(next.hostUserId, `${next.guestUsername} joined your game`, 'Your first turn is ready.', next.id, sub, 'turn');
  return liveResponse(next);
}

async function getLiveGameForUser(sub, id) {
  const current = await readLiveGame(clean(id, 80));
  assertLiveParticipant(current.state, sub);
  return liveResponse(current.state);
}

async function listLiveGames(sub) {
  const items = await scanAll(table, { FilterExpression: 'begins_with(pk, :prefix)', ExpressionAttributeValues: { ':prefix': s('LIVE#') }, ProjectionExpression: '#state', ExpressionAttributeNames: { '#state': 'state' } });
  return items.map(parseLiveItem).filter((state) => state && (state.hostUserId === sub || state.guestUserId === sub) && ['INVITED', 'WAITING', 'ACTIVE'].includes(state.status) && (!['INVITED', 'WAITING'].includes(state.status) || Date.now() - new Date(state.createdAt).getTime() <= 24 * 60 * 60 * 1000)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(liveResponse);
}

async function abandonLiveGamesForUser(sub) {
  const items = await scanAll(table, { FilterExpression: 'begins_with(pk, :prefix)', ExpressionAttributeValues: { ':prefix': s('LIVE#') }, ProjectionExpression: 'pk, #state, version', ExpressionAttributeNames: { '#state': 'state' } });
  const active = items.filter((item) => {
    const state = parseLiveItem(item);
    return state && (state.hostUserId === sub || state.guestUserId === sub) && ['INVITED', 'WAITING', 'ACTIVE'].includes(state.status);
  });
  await Promise.all(active.map(async (item) => {
    const state = parseLiveItem(item);
    try {
      const next = await saveLiveGame({ ...state, status: 'ABANDONED', endedByUserId: sub }, Number(item.version?.N ?? 0));
      const opponentId = sub === next.hostUserId ? next.guestUserId : next.hostUserId;
      await notifyLivePlayer(opponentId, 'Remote game ended', `${sub === next.hostUserId ? next.hostUsername : next.guestUsername} left the game.`, next.id, sub);
    } catch (error) {
      if (error.message !== 'The game changed on the other device. Please try again.') throw error;
    }
  }));
}

async function updateLiveGame(sub, id, rawAction) {
  let action;
  try { action = typeof rawAction === 'string' ? JSON.parse(rawAction) : rawAction; } catch { throw new Error('Invalid game action.'); }
  const current = await readLiveGame(clean(id, 80));
  const state = current.state;
  assertLiveParticipant(state, sub);
  const actionId = clean(action?.actionId, 80);
  if (actionId && (state.processedActionIds || []).includes(actionId)) return liveResponse(state);
  if (action?.type === 'RESPOND_INVITE') {
    if (state.status !== 'INVITED' || state.guestUserId !== sub) throw new Error('This challenge is no longer available.');
    const accepted = Boolean(action.accept);
    const next = await saveLiveGame({ ...state, status: accepted ? 'ACTIVE' : 'DECLINED', endedByUserId: accepted ? null : sub, processedActionIds: actionId ? [...(state.processedActionIds || []), actionId].slice(-40) : state.processedActionIds }, current.version);
    try { await notifyLivePlayer(next.hostUserId, accepted ? 'Challenge accepted' : 'Challenge declined', `${next.guestUsername} ${accepted ? 'accepted' : 'declined'} your Remote Game challenge.`, next.id, sub, 'invite'); } catch { /* The response is saved even if push delivery fails. */ }
    return liveResponse(next);
  }
  if (action?.type === 'REMATCH') return await createLiveRematch(state, sub);
  if (action?.type === 'LEAVE') {
    if (!['INVITED', 'WAITING', 'ACTIVE'].includes(state.status)) return liveResponse(state);
    const next = await saveLiveGame({ ...state, status: 'ABANDONED', endedByUserId: sub, processedActionIds: actionId ? [...(state.processedActionIds || []), actionId].slice(-40) : state.processedActionIds }, current.version);
    const opponentId = sub === next.hostUserId ? next.guestUserId : next.hostUserId;
    await notifyLivePlayer(opponentId, 'Remote game ended', `${sub === next.hostUserId ? next.hostUsername : next.guestUsername} left the game.`, next.id, sub);
    return liveResponse(next);
  }
  if (state.status !== 'ACTIVE') throw new Error('The game is not active yet.');
  if (state.currentUserId !== sub) throw new Error('Wait for your opponent to finish their turn.');
  const scoresKey = sub === state.hostUserId ? 'hostScores' : 'guestScores';
  const scores = state[scoresKey];
  let next = { ...state };
  if (action?.type === 'ROLL') {
    if (state.rollsLeft < 1) throw new Error('No rolls remain this turn.');
    const held = new Set(state.held);
    next.dice = state.dice.map((die, index) => held.has(index) ? die : randomInt(1, 7));
    next.rollsLeft = state.rollsLeft - 1; next.hasRolled = true; next.selectedCategory = null;
  } else if (action?.type === 'TOGGLE_HOLD') {
    const index = Number(action.index);
    if (!state.hasRolled || !Number.isInteger(index) || index < 0 || index > 4) throw new Error('That die cannot be held.');
    const held = new Set(state.held); held.has(index) ? held.delete(index) : held.add(index); next.held = [...held].sort();
  } else if (action?.type === 'SELECT_CATEGORY') {
    const category = clean(action.category, 30);
    if (!state.hasRolled || !liveCategoryEligible(category, state.dice, scores)) throw new Error('That category is not available.');
    next.selectedCategory = category;
  } else if (action?.type === 'LOCK_CATEGORY') {
    const category = clean(action.category || state.selectedCategory, 30);
    if (!state.hasRolled || !category) throw new Error('Choose a category first.');
    const entry = { category, score: liveScoreCategory(category, state.dice, scores), dice: [...state.dice], yahtzeeBonus: liveBonus(scores, state.dice) };
    next[scoresKey] = [...scores, entry];
    const complete = next[scoresKey].length === 13 && (sub === state.hostUserId ? next.guestScores.length === 13 : next.hostScores.length === 13);
    if (complete) {
      const hostTotal = liveTotal(next.hostScores); const guestTotal = liveTotal(next.guestScores);
      next.status = 'COMPLETED'; next.winnerUserId = hostTotal === guestTotal ? null : hostTotal > guestTotal ? next.hostUserId : next.guestUserId;
    } else {
      next.currentUserId = sub === state.hostUserId ? state.guestUserId : state.hostUserId;
      next.round = Math.min(13, Math.min(next.hostScores.length, next.guestScores.length) + 1);
      next = newLiveTurn(next);
    }
  } else throw new Error('Unsupported game action.');
  if (actionId) next.processedActionIds = [...(state.processedActionIds || []), actionId].slice(-40);
  const saved = await saveLiveGame(next, current.version);
  if (action.type === 'LOCK_CATEGORY' && saved.status === 'ACTIVE') {
    const actor = sub === saved.hostUserId ? saved.hostUsername : saved.guestUsername;
    await notifyLivePlayer(saved.currentUserId, 'Your turn', `${actor} finished Round ${Math.max(saved.hostScores.length, saved.guestScores.length)}.`, saved.id, sub, 'turn');
  }
  if (action.type === 'LOCK_CATEGORY' && saved.status === 'COMPLETED') {
    const opponentId = sub === saved.hostUserId ? saved.guestUserId : saved.hostUserId;
    const hostTotal = liveTotal(saved.hostScores); const guestTotal = liveTotal(saved.guestScores);
    const result = saved.winnerUserId === null ? 'It’s a draw.' : saved.winnerUserId === opponentId ? 'You won!' : 'Your opponent won.';
    try { await notifyLivePlayer(opponentId, 'Remote game finished', `${result} ${saved.hostUsername} ${hostTotal}–${guestTotal} ${saved.guestUsername}.`, saved.id, sub, 'update'); } catch { /* The final score is saved even if push delivery fails. */ }
  }
  return liveResponse(saved);
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
  if (field === 'createLiveGame') return await createLiveGame(sub, claims);
  if (field === 'challengeLiveGame') return await challengeLiveGame(sub, claims, event.args.userId, event.args.username);
  if (field === 'joinLiveGame') return await joinLiveGame(sub, claims, event.args.code);
  if (field === 'liveGame') return await getLiveGameForUser(sub, event.args.gameId);
  if (field === 'myLiveGames') return await listLiveGames(sub);
  if (field === 'updateLiveGame') return await updateLiveGame(sub, event.args.gameId, event.args.action);
  if (field === 'sendAdminNotification') return await sendAdminNotification(claims, event.args ?? {});
  if (field === 'recordGameLifecycleEvent') {
    const gameId = clean(event.args.gameId, 100);
    const mode = clean(event.args.mode, 20).toUpperCase();
    const action = clean(event.args.action, 24).toUpperCase();
    const platform = clean(event.args.platform, 12).toUpperCase();
    if (!gameId || !lifecycleModes.has(mode) || !lifecycleActions.has(action) || !lifecyclePlatforms.has(platform)) throw new Error('Invalid game lifecycle event.');
    const round = Math.max(1, Math.min(13, Number(event.args.round) || 1));
    const score = Math.max(0, Math.min(2000, Number(event.args.score) || 0));
    const categoriesFilled = Math.max(0, Math.min(26, Number(event.args.categoriesFilled) || 0));
    const profile = await getProfile(sub);
    await db.send(new PutItemCommand({ TableName: table, Item: {
      pk: s(`GAME_EVENT#${gameId}#${action}`), gameId: s(gameId), userId: s(sub),
      username: s(profile?.username || claims.preferred_username || claims.email || 'Player'),
      action: s(action), mode: s(mode), round: { N: String(round) }, score: { N: String(score) },
      categoriesFilled: { N: String(categoriesFilled) }, platform: s(platform), occurredAt: s(new Date().toISOString()),
    } }));
    return true;
  }
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
      notifyTurns: true, notifyInvites: true, notifyGameUpdates: true,
      expoPushToken: '',
    };
    return { ...profile, role: isAdmin(claims) ? 'ADMIN' : 'PLAYER' };
  }
  if (field === 'deleteMyProfile') {
    const current = await getProfile(sub);
    await abandonLiveGamesForUser(sub);
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
    const profile = { ...current, scoreSuggestionsEnabled: Boolean(event.args.scoreSuggestionsEnabled), dailyReminderEnabled: Boolean(event.args.dailyReminderEnabled), dailyReminderHour: hour,
      notifyTurns: event.args.notifyTurns == null ? current.notifyTurns : Boolean(event.args.notifyTurns),
      notifyInvites: event.args.notifyInvites == null ? current.notifyInvites : Boolean(event.args.notifyInvites),
      notifyGameUpdates: event.args.notifyGameUpdates == null ? current.notifyGameUpdates : Boolean(event.args.notifyGameUpdates) };
    await db.send(new TransactWriteItemsCommand({ TransactItems: [{ Put: { TableName: table, Item: {
      pk: s(profileKey(sub)), userId: s(sub), username: s(profile.username), usernameNormalised: s(normalise(profile.username)), firstName: s(profile.firstName), lastName: s(profile.lastName),
      scoreSuggestionsEnabled: { BOOL: profile.scoreSuggestionsEnabled }, dailyReminderEnabled: { BOOL: profile.dailyReminderEnabled }, dailyReminderHour: { N: String(profile.dailyReminderHour) },
      pushNotificationsEnabled: { BOOL: current.pushNotificationsEnabled }, ...(current.expoPushToken ? { expoPushToken: s(current.expoPushToken) } : {}),
      notifyTurns: { BOOL: profile.notifyTurns }, notifyInvites: { BOOL: profile.notifyInvites }, notifyGameUpdates: { BOOL: profile.notifyGameUpdates },
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
      notifyTurns: { BOOL: profile.notifyTurns }, notifyInvites: { BOOL: profile.notifyInvites }, notifyGameUpdates: { BOOL: profile.notifyGameUpdates },
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
      notifyTurns: { BOOL: current?.notifyTurns ?? true }, notifyInvites: { BOOL: current?.notifyInvites ?? true }, notifyGameUpdates: { BOOL: current?.notifyGameUpdates ?? true },
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
  if (!current) await notifyAdminsOfNewUser(username);
  return { userId: sub, username, firstName, lastName, scoreSuggestionsEnabled: current?.scoreSuggestionsEnabled ?? true, dailyReminderEnabled: current?.dailyReminderEnabled ?? false, dailyReminderHour: current?.dailyReminderHour ?? 19, pushNotificationsEnabled: current?.pushNotificationsEnabled ?? false, notifyTurns: current?.notifyTurns ?? true, notifyInvites: current?.notifyInvites ?? true, notifyGameUpdates: current?.notifyGameUpdates ?? true, expoPushToken: current?.expoPushToken ?? '', role: isAdmin(claims) ? 'ADMIN' : 'PLAYER' };
};
