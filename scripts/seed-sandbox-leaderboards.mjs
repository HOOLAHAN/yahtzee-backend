import { spawnSync } from 'node:child_process';

const region = 'eu-west-2';
const profile = 'iain-hoolahan';
const gameResultTable = 'GameResult-ugvdkhksofdfzbu232gy2gbz5i-sandbox';
const playerNames = ['Avery', 'Blake', 'Casey', 'Devon', 'Emery', 'Finley', 'Gray', 'Harper', 'Indigo', 'Jules', 'Kai', 'Lane'];
const scorecard = JSON.stringify({ Ones: 3, Twos: 6, Threes: 9, Fours: 12, Fives: 15, Sixes: 18, 'Three of a Kind': 22, 'Four of a Kind': 24, 'Full House': 25, 'Small Straight': 30, 'Large Straight': 40, Yahtzee: 0, Chance: 23 });

const attribute = (value) => typeof value === 'number' ? { N: String(value) } : typeof value === 'boolean' ? { BOOL: value } : { S: value };
const item = (values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, attribute(value)]));
const isoDaysAgo = (days, hour, minute) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
};
const dateDaysAgo = (days) => isoDaysAgo(days, 12, 0).slice(0, 10);

const records = [];
playerNames.forEach((name, playerIndex) => {
  const userId = `seed-v32-user-${String(playerIndex + 1).padStart(2, '0')}`;
  const username = `Seed_${name}`;

  // Several Solo games per user deliberately exercise highest-score deduping.
  for (let game = 0; game < 7; game += 1) {
    const score = Math.min(355, 155 + playerIndex * 11 + game * 9 + (playerIndex === 0 ? game * 16 : 0));
    // Give every player a result today so calendar-week filtering is useful
    // even when the seed is run on a Monday. Older games exercise Month/All Time.
    const daysAgo = game === 0 ? 0 : game * 5 + (playerIndex % 4);
    const completedAt = isoDaysAgo(daysAgo, 9 + game, playerIndex * 3);
    records.push(item({
      id: `seed-v32-solo-${playerIndex + 1}-${game + 1}`, userId, username, mode: 'SOLO', modeDate: 'SOLO#ALL', score, completedAt,
      yahtzeeCount: score >= 300 ? 1 : 0, earnedUpperBonus: score >= 230, completedSmallStraight: score >= 190,
      completedLargeStraight: score >= 245, noZeroScores: score >= 285, yahtzeeOnFinalRoll: false, scorecard,
      createdAt: completedAt, updatedAt: completedAt, __typename: 'GameResult',
    }));
  }

  // Ten recent Daily results provide useful Today, Week, Month and All Time views.
  for (let day = 0; day < 10; day += 1) {
    const challengeDate = dateDaysAgo(day);
    const score = Math.min(360, 170 + playerIndex * 9 + ((day * 17 + playerIndex * 5) % 72));
    const completedAt = isoDaysAgo(day, 18, playerIndex * 2);
    records.push(item({
      id: `seed-v32-daily-${challengeDate}-${playerIndex + 1}`, userId, username, mode: 'DAILY', modeDate: `DAILY#${challengeDate}`, challengeDate, score, completedAt,
      yahtzeeCount: score >= 310 ? 1 : 0, earnedUpperBonus: score >= 235, completedSmallStraight: true,
      completedLargeStraight: score >= 250, noZeroScores: score >= 290, yahtzeeOnFinalRoll: false, scorecard,
      createdAt: completedAt, updatedAt: completedAt, __typename: 'GameResult',
    }));
  }
});

for (let offset = 0; offset < records.length; offset += 25) {
  const requestItems = { [gameResultTable]: records.slice(offset, offset + 25).map((record) => ({ PutRequest: { Item: record } })) };
  const result = spawnSync('aws', ['dynamodb', 'batch-write-item', '--region', region, '--profile', profile, '--request-items', JSON.stringify(requestItems), '--output', 'json'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `AWS CLI exited with ${result.status}`);
  const response = JSON.parse(result.stdout || '{}');
  const unprocessed = response.UnprocessedItems?.[gameResultTable] ?? [];
  if (unprocessed.length) throw new Error(`${unprocessed.length} records were not processed; rerun the seed command.`);
}

console.log(`Seeded ${records.length} sandbox GameResult records for ${playerNames.length} synthetic players.`);
