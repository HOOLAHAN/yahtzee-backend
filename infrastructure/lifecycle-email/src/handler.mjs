import cognitoSdk from '@aws-sdk/client-cognito-identity-provider';
import dynamoSdk from '@aws-sdk/client-dynamodb';
import dynamoDocumentSdk from '@aws-sdk/lib-dynamodb';
import sesSdk from '@aws-sdk/client-sesv2';
import { createHash, randomUUID } from 'node:crypto';

const { CognitoIdentityProviderClient, ListUsersCommand } = cognitoSdk;
const { DynamoDBClient } = dynamoSdk;
const { DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } = dynamoDocumentSdk;
const { CreateContactCommand, SESv2Client, SendEmailCommand, UpdateContactCommand } = sesSdk;

const region = process.env.AWS_REGION || 'eu-west-2';
const cognito = new CognitoIdentityProviderClient({ region });
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), { marshallOptions: { removeUndefinedValues: true } });
const ses = new SESv2Client({ region });
const tableName = process.env.STATE_TABLE;
const gameTable = process.env.GAME_RESULT_TABLE;
const userPoolId = process.env.USER_POOL_ID;
const contactList = process.env.CONTACT_LIST_NAME || 'yahtzee-marketing';
const topicName = process.env.TOPIC_NAME || 'lifecycle-emails';
const consentVersionDefault = process.env.CONSENT_VERSION || '2026-09-21';

const nowIso = () => new Date().toISOString();
const userPk = (sub) => `USER#${sub}`;
const stateKey = (sub) => ({ pk: userPk(sub), sk: 'STATE' });
const campaignKey = (sub, campaign) => ({ pk: userPk(sub), sk: `CAMPAIGN#${campaign}` });
const emailHash = (email) => createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
const boolEnv = (name) => String(process.env[name] || '').toLowerCase() === 'true';
const daysAgo = (iso) => iso ? (Date.now() - Date.parse(iso)) / 86_400_000 : Number.POSITIVE_INFINITY;

function claimsFrom(event) {
  return event?.identity?.claims || {};
}

function caller(event) {
  const claims = claimsFrom(event);
  const sub = claims.sub;
  const email = claims.email;
  if (!sub || !email) throw new Error('A verified signed-in account is required.');
  return { sub, email: String(email).trim().toLowerCase() };
}

function publicPreference(item = {}) {
  return {
    enabled: item.consentStatus === 'OPT_IN',
    consentedAt: item.consentedAt || null,
    consentVersion: item.consentVersion || null,
    consentSource: item.consentSource || null,
    unsubscribedAt: item.unsubscribedAt || null,
    firstWebSeenAt: item.firstWebSeenAt || null,
    lastWebSeenAt: item.lastWebSeenAt || null,
    firstMobileSeenAt: item.firstMobileSeenAt || null,
    lastMobileSeenAt: item.lastMobileSeenAt || null,
  };
}

async function getState(sub) {
  const result = await db.send(new GetCommand({ TableName: tableName, Key: stateKey(sub), ConsistentRead: true }));
  return result.Item || null;
}

async function myPreference(event) {
  const { sub } = caller(event);
  return publicPreference(await getState(sub));
}

async function upsertContact({ email, subscriptionStatus, attributes }) {
  const input = {
    ContactListName: contactList,
    EmailAddress: email,
    TopicPreferences: [{ TopicName: topicName, SubscriptionStatus: subscriptionStatus }],
    AttributesData: JSON.stringify(attributes),
  };
  try {
    await ses.send(new CreateContactCommand(input));
  } catch (error) {
    if (error?.name !== 'AlreadyExistsException') throw error;
    await ses.send(new UpdateContactCommand(input));
  }
}

async function updatePreference(event) {
  const { sub, email } = caller(event);
  const enabled = event.arguments?.enabled === true;
  const version = String(event.arguments?.consentVersion || consentVersionDefault).slice(0, 80);
  const source = String(event.arguments?.source || event.request?.headers?.['x-yahtzee-platform'] || 'WEB').toUpperCase();
  if (!['WEB', 'IOS', 'ANDROID'].includes(source)) throw new Error('Unsupported consent source.');
  const timestamp = nowIso();

  await upsertContact({
    email,
    subscriptionStatus: enabled ? 'OPT_IN' : 'OPT_OUT',
    attributes: { userId: sub, consentVersion: version, source },
  });

  const result = await db.send(new UpdateCommand({
    TableName: tableName,
    Key: stateKey(sub),
    UpdateExpression: `SET emailAddress = :email, emailHash = :hash, consentStatus = :status,
      consentVersion = :version, consentSource = :source, consentUpdatedAt = :now,
      createdAt = if_not_exists(createdAt, :now), updatedAt = :now${enabled ? ', consentedAt = :now REMOVE unsubscribedAt' : ', unsubscribedAt = :now'}`,
    ExpressionAttributeValues: {
      ':email': email, ':hash': emailHash(email), ':status': enabled ? 'OPT_IN' : 'OPT_OUT',
      ':version': version, ':source': source, ':now': timestamp,
    },
    ReturnValues: 'ALL_NEW',
  }));
  return publicPreference(result.Attributes);
}

async function recordActivity(event) {
  const { sub, email } = caller(event);
  const platform = String(event.arguments?.platform || '').toUpperCase();
  if (!['WEB', 'IOS', 'ANDROID'].includes(platform)) throw new Error('Unsupported client platform.');
  const now = nowIso();
  const isWeb = platform === 'WEB';
  const firstField = isWeb ? 'firstWebSeenAt' : 'firstMobileSeenAt';
  const lastField = isWeb ? 'lastWebSeenAt' : 'lastMobileSeenAt';
  const result = await db.send(new UpdateCommand({
    TableName: tableName,
    Key: stateKey(sub),
    UpdateExpression: `SET emailAddress = if_not_exists(emailAddress, :email), emailHash = if_not_exists(emailHash, :hash),
      consentStatus = if_not_exists(consentStatus, :optout), createdAt = if_not_exists(createdAt, :now),
      ${firstField} = if_not_exists(${firstField}, :now), ${lastField} = :now, lastPlatform = :platform, updatedAt = :now`,
    ExpressionAttributeValues: { ':email': email, ':hash': emailHash(email), ':optout': 'OPT_OUT', ':now': now, ':platform': platform },
    ReturnValues: 'ALL_NEW',
  }));
  return publicPreference(result.Attributes);
}

async function deleteLifecycleData(event) {
  const { sub, email } = caller(event);
  await upsertContact({
    email,
    subscriptionStatus: 'OPT_OUT',
    attributes: { deletedAccount: true },
  }).catch((error) => console.warn('Unable to update SES contact during account deletion', error));
  let ExclusiveStartKey;
  do {
    const page = await db.send(new QueryCommand({ TableName: tableName, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': userPk(sub) }, ExclusiveStartKey }));
    for (const item of page.Items || []) await db.send(new DeleteCommand({ TableName: tableName, Key: { pk: item.pk, sk: item.sk } }));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return true;
}

async function listCognitoUsers() {
  const users = [];
  let PaginationToken;
  do {
    const page = await cognito.send(new ListUsersCommand({ UserPoolId: userPoolId, PaginationToken, Limit: 60 }));
    users.push(...(page.Users || []));
    PaginationToken = page.PaginationToken;
  } while (PaginationToken);
  return users;
}

async function allGames() {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await db.send(new ScanCommand({
      TableName: gameTable,
      ExclusiveStartKey,
      ProjectionExpression: 'userId, completedAt',
    }));
    items.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

const campaigns = {
  FIRST_GAME: {
    enabled: () => boolEnv('ENABLE_FIRST_GAME'),
    template: process.env.FIRST_GAME_TEMPLATE || 'yahtzee-first-game',
    eligible: ({ state, games, createdAt }) => games.length === 0 && daysAgo(createdAt) >= Number(process.env.FIRST_GAME_DELAY_DAYS || 1),
  },
  DOWNLOAD_APP: {
    enabled: () => boolEnv('ENABLE_DOWNLOAD_APP'),
    template: process.env.DOWNLOAD_APP_TEMPLATE || 'yahtzee-download-app',
    eligible: ({ state }) => Boolean(state.firstWebSeenAt) && !state.firstMobileSeenAt && daysAgo(state.firstWebSeenAt) >= Number(process.env.DOWNLOAD_APP_DELAY_DAYS || 7),
  },
  INACTIVE_PLAYER: {
    enabled: () => boolEnv('ENABLE_INACTIVE_PLAYER'),
    template: process.env.INACTIVE_PLAYER_TEMPLATE || 'yahtzee-inactive-player',
    eligible: ({ games }) => games.length > 0 && daysAgo(games.at(-1)?.completedAt) >= Number(process.env.INACTIVE_DELAY_DAYS || 30),
  },
};

async function alreadySent(sub, campaign) {
  const result = await db.send(new GetCommand({ TableName: tableName, Key: campaignKey(sub, campaign), ConsistentRead: true }));
  if (!result.Item?.sentAt) return false;
  if (campaign !== 'INACTIVE_PLAYER') return true;
  return daysAgo(result.Item.sentAt) < Number(process.env.INACTIVE_COOLDOWN_DAYS || 90);
}

async function reserveCampaign(sub, campaign) {
  const id = randomUUID();
  const now = nowIso();
  try {
    await db.send(new PutCommand({
      TableName: tableName,
      Item: { ...campaignKey(sub, campaign), lifecycleMessageId: id, campaign, reservedAt: now, status: 'RESERVED' },
      ConditionExpression: campaign === 'INACTIVE_PLAYER'
        ? 'attribute_not_exists(reservedAt) OR reservedAt < :stale'
        : 'attribute_not_exists(pk)',
      ExpressionAttributeValues: campaign === 'INACTIVE_PLAYER'
        ? { ':stale': new Date(Date.now() - Number(process.env.INACTIVE_COOLDOWN_DAYS || 90) * 86_400_000).toISOString() }
        : undefined,
    }));
    return id;
  } catch (error) {
    if (error?.name === 'ConditionalCheckFailedException') return null;
    throw error;
  }
}

async function sendCampaign({ sub, email, username, campaign, definition }) {
  const lifecycleMessageId = await reserveCampaign(sub, campaign);
  if (!lifecycleMessageId) return false;
  const appStoreUrl = process.env.APP_STORE_URL || 'https://apps.apple.com/gb/app/yahtzee-hub/id6794910138';
  const webUrl = `https://yahtzee.ijrhservices.co.uk/?utm_source=yahtzee_lifecycle&utm_medium=email&utm_campaign=${campaign.toLowerCase()}&lc=${encodeURIComponent(lifecycleMessageId)}`;
  const response = await ses.send(new SendEmailCommand({
    FromEmailAddress: process.env.FROM_EMAIL || 'Yahtzee <play@yahtzee.ijrhservices.co.uk>',
    ReplyToAddresses: [process.env.REPLY_TO_EMAIL || 'accounts@yahtzee.ijrhservices.co.uk'],
    Destination: { ToAddresses: [email] },
    ConfigurationSetName: process.env.CONFIGURATION_SET || 'yahtzee-marketing',
    ListManagementOptions: { ContactListName: contactList, TopicName: topicName },
    EmailTags: [
      { Name: 'campaign', Value: campaign.toLowerCase() },
      { Name: 'environment', Value: process.env.STAGE || 'unknown' },
      { Name: 'lifecycleMessageId', Value: lifecycleMessageId.replaceAll('-', '') },
    ],
    Content: { Template: { TemplateName: definition.template, TemplateData: JSON.stringify({ username, webUrl, appStoreUrl, lifecycleMessageId }) } },
  }));
  const sentAt = nowIso();
  await db.send(new UpdateCommand({
    TableName: tableName,
    Key: campaignKey(sub, campaign),
    UpdateExpression: 'SET sentAt = :sentAt, #status = :status, sesMessageId = :messageId, recipientHash = :hash',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':sentAt': sentAt, ':status': 'SENT', ':messageId': response.MessageId, ':hash': emailHash(email) },
  }));
  await db.send(new PutCommand({
    TableName: tableName,
    Item: { pk: `MESSAGE#${response.MessageId}`, sk: 'EVENTS', userId: sub, campaign, lifecycleMessageId, sentAt },
  }));
  return true;
}

async function evaluateCampaigns() {
  const [users, games] = await Promise.all([listCognitoUsers(), allGames()]);
  const gamesByUser = new Map();
  for (const game of games) {
    if (!gamesByUser.has(game.userId)) gamesByUser.set(game.userId, []);
    gamesByUser.get(game.userId).push(game);
  }
  for (const values of gamesByUser.values()) values.sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt)));
  const report = { evaluated: users.length, optedIn: 0, eligible: 0, sent: 0, dryRun: boolEnv('DRY_RUN'), campaigns: {} };
  for (const user of users) {
    const attributes = Object.fromEntries((user.Attributes || []).map(({ Name, Value }) => [Name, Value]));
    if (user.UserStatus !== 'CONFIRMED' || !attributes.sub || !attributes.email) continue;
    const state = await getState(attributes.sub);
    if (state?.consentStatus !== 'OPT_IN' || state.hardBounceAt || state.complaintAt || state.unsubscribedAt) continue;
    report.optedIn += 1;
    const context = { state, games: gamesByUser.get(attributes.sub) || [], createdAt: user.UserCreateDate?.toISOString() };
    for (const [campaign, definition] of Object.entries(campaigns)) {
      if (!definition.enabled() || !definition.eligible(context) || await alreadySent(attributes.sub, campaign)) continue;
      report.eligible += 1;
      report.campaigns[campaign] = (report.campaigns[campaign] || 0) + 1;
      if (!report.dryRun && await sendCampaign({ sub: attributes.sub, email: attributes.email, username: attributes.preferred_username || 'player', campaign, definition })) report.sent += 1;
    }
  }
  console.info('Lifecycle evaluation', JSON.stringify(report));
  return report;
}

function sesEventType(event) {
  return String(event?.detail?.eventType || event?.detail?.event_type || event?.['detail-type'] || '').toUpperCase().replaceAll(' ', '_');
}

async function handleSesEvent(event) {
  const detail = event.detail || {};
  const messageId = detail.mail?.messageId || detail.mail?.message_id;
  if (!messageId) return { ignored: true };
  const key = { pk: `MESSAGE#${messageId}`, sk: 'EVENTS' };
  const current = await db.send(new GetCommand({ TableName: tableName, Key: key }));
  if (!current.Item) return { ignored: true };
  const type = sesEventType(event);
  const timestamp = nowIso();
  const field = type.includes('COMPLAINT') ? 'complaintAt'
    : type.includes('BOUNCE') ? 'hardBounceAt'
    : type.includes('SUBSCRIPTION') ? 'subscriptionUpdatedAt'
    : type.includes('CLICK') ? 'clickedAt'
    : type.includes('DELIVERY') ? 'deliveredAt'
    : type.includes('RENDER') ? 'renderingFailedAt' : 'lastEventAt';
  await db.send(new UpdateCommand({
    TableName: tableName, Key: key,
    UpdateExpression: 'SET #field = :now, lastEventType = :type',
    ExpressionAttributeNames: { '#field': field }, ExpressionAttributeValues: { ':now': timestamp, ':type': type },
  }));
  const subscriptionOptedOut = field === 'subscriptionUpdatedAt' && ['OPT_OUT', 'UNSUBSCRIBED'].includes(String(detail.subscription?.topicSubscriptionStatus || detail.subscription?.newTopicPreferences?.[topicName] || '').toUpperCase());
  if ((['complaintAt', 'hardBounceAt'].includes(field) || subscriptionOptedOut) && current.Item.userId) {
    await db.send(new UpdateCommand({
      TableName: tableName, Key: stateKey(current.Item.userId),
      UpdateExpression: `SET ${field} = :now, consentStatus = :optout, unsubscribedAt = if_not_exists(unsubscribedAt, :now), updatedAt = :now`,
      ExpressionAttributeValues: { ':now': timestamp, ':optout': 'OPT_OUT' },
    }));
  }
  return { processed: true, type };
}

export const handler = async (event) => {
  if (!tableName) throw new Error('STATE_TABLE is not configured.');
  const field = event?.info?.fieldName;
  if (field === 'myLifecycleEmailPreference') return myPreference(event);
  if (field === 'updateMyLifecycleEmailPreference') return updatePreference(event);
  if (field === 'recordClientActivity') return recordActivity(event);
  if (field === 'deleteMyLifecycleEmailData') return deleteLifecycleData(event);
  if (event?.source === 'yahtzee.lifecycle.evaluate') return evaluateCampaigns();
  if (event?.source === 'aws.ses' || String(event?.['detail-type'] || '').toLowerCase().includes('email')) return handleSesEvent(event);
  throw new Error('Unsupported lifecycle operation.');
};
