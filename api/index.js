const express = require('express');
const { TwitterApi } = require('twitter-api-v2');
const { DateTime } = require('luxon');
const app = express();

app.use(express.json());
app.use(express.static('public'));

// 替换为你的X开发者账户的Bearer Token（从 https://developer.x.com 获取）
const BEARER_TOKEN = 'YOUR_BEARER_TOKEN_HERE'; // 替换
const TARGET_USER_ID = '1263316369044467712'; // @findom77230615
let userAccessToken = null; // 临时存储（生产用数据库）

// 获取授权URL
app.get('/api/auth-url', (req, res) => {
  const client = new TwitterApi({
    appKey: 'YOUR_API_KEY_HERE',
    appSecret: 'YOUR_API_SECRET_HERE',
  });

  const { url, codeVerifier, state } = client.generateOAuth2PKCEUrl({
    scopes: ['tweet.read', 'users.read', 'follows.write', 'likes.write', 'tweet.write', 'offline.access'],
    codeChallengeMethod: 's256',
  });

  global.codeVerifier = codeVerifier;
  global.state = state;
  res.json({ authUrl: url });
});

// 回调处理
app.get('/api/callback', async (req, res) => {
  const { code, state } = req.query;
  if (state !== global.state) {
    return res.status(400).json({ error: 'State mismatch' });
  }

  const client = new TwitterApi({
    appKey: 'YOUR_API_KEY_HERE',
    appSecret: 'YOUR_API_SECRET_HERE',
  });

  try {
    const { accessToken } = await client.loginWithOAuth2({
      code,
      codeVerifier: global.codeVerifier,
      redirectUri: 'https://fatu-snowy.vercel.app/api/callback',
    });

    userAccessToken = accessToken;
    const userClient = new TwitterApi({ accessToken });
    const me = await userClient.v2.me();
    const userId = me.data.id;

    // 关注@findom77230615
    await userClient.v2.follow(userId, TARGET_USER_ID);

    // 获取本周推文
    const client = new TwitterApi(BEARER_TOKEN);
    const weekStart = DateTime.now().minus({ days: 7 }).toISO();
    const tweets = await client.v2.userTimeline(TARGET_USER_ID, {
      max_results: 10,
      'tweet.fields': 'created_at',
      exclude: 'retweets,replies',
      start_time: weekStart,
    });

    const tweetIds = (tweets.data?.data || []).slice(0, 5);
    for (const tweet of tweetIds) {
      await userClient.v2.repost(userId, tweet.id);
      await userClient.v2.like(userId, tweet.id);
    }

    res.redirect(`/success?userId=${userId}`);
  } catch (error) {
    res.status(500).json({ error: 'Auth failed', details: error.message });
  }
});

// 每天凌晨3点检查前一天推文
app.get('/api/daily-check', async (req, res) => {
  if (!userAccessToken) {
    return res.status(401).json({ error: 'Not authorized' });
  }

  const client = new TwitterApi(BEARER_TOKEN);
  const userClient = new TwitterApi({ accessToken: userAccessToken });

  try {
    const yesterdayStart = DateTime.now().minus({ days: 1 }).startOf('day').toISO();
    const yesterdayEnd = DateTime.now().minus({ days: 1 }).endOf('day').toISO();
    const tweets = await client.v2.userTimeline(TARGET_USER_ID, {
      max_results: 10,
      'tweet.fields': 'created_at',
      exclude: 'retweets,replies',
      start_time: yesterdayStart,
      end_time: yesterdayEnd,
    });

    const me = await userClient.v2.me();
    const userId = me.data.id;
    const tweetIds = tweets.data?.data || [];
    for (const tweet of tweetIds) {
      await userClient.v2.repost(userId, tweet.id);
      await userClient.v2.like(userId, tweet.id);
    }

    res.json({ processed: tweetIds.length });
  } catch (error) {
    res.status(500).json({ error: 'Daily check failed', details: error.message });
  }
});

module.exports = app;