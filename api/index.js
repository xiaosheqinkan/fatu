const express = require('express');
const { TwitterApi } = require('twitter-api-v2');
const { DateTime } = require('luxon');
const { kv } = require('@vercel/kv');
const app = express();

app.use(express.json());
app.use(express.static('public'));

// 从环境变量读取密钥
const BEARER_TOKEN = process.env.X_BEARER_TOKEN;
const API_KEY = process.env.X_API_KEY;
const API_SECRET = process.env.X_API_SECRET;
const TARGET_USER_ID = '1263316369044467712'; // @findom77230615

// 获取授权URL
app.get('/api/auth-url', async (req, res) => {
  const client = new TwitterApi({
    appKey: API_KEY,
    appSecret: API_SECRET,
  });

  const sessionId = Date.now().toString() + Math.random().toString(36).slice(2); // 唯一会话ID
  const { url, codeVerifier, state } = client.generateOAuth2PKCEUrl({
    scopes: ['tweet.read', 'users.read', 'follows.write', 'likes.write', 'tweet.write', 'offline.access'],
    codeChallengeMethod: 's256',
  });

  // 存储 state 和 codeVerifier 到 Vercel KV
  try {
    await kv.set(`auth:${sessionId}`, { state, codeVerifier }, { ex: 600 }); // 10分钟过期
    res.json({ authUrl: `${url}&state=${encodeURIComponent(state + '|' + sessionId)}` });
  } catch (error) {
    console.error('KV store error:', error);
    res.status(500).json({ error: 'Failed to store auth data' });
  }
});

// 回调处理：关注 + 点赞/转发最新5条推文
app.get('/api/callback', async (req, res) => {
  const { code, state } = req.query;
  const [originalState, sessionId] = state ? state.split('|') : ['', ''];

  // 从 Vercel KV 获取存储的 state 和 codeVerifier
  let stored;
  try {
    stored = await kv.get(`auth:${sessionId}`);
    if (!stored || originalState !== stored.state) {
      console.error('State mismatch:', { received: originalState, expected: stored?.state, sessionId });
      return res.status(400).json({ error: 'Invalid state parameter' });
    }
  } catch (error) {
    console.error('KV retrieve error:', error);
    return res.status(500).json({ error: 'Failed to retrieve auth data' });
  }

  const client = new TwitterApi({
    appKey: API_KEY,
    appSecret: API_SECRET,
  });

  try {
    const { accessToken, refreshToken } = await client.loginWithOAuth2({
      code,
      codeVerifier: stored.codeVerifier,
      redirectUri: 'https://fatu-snowy.vercel.app/api/callback',
    });

    const userClient = new TwitterApi({ accessToken });
    const me = await userClient.v2.me();
    const userId = me.data.id;

    // 存储用户 accessToken 和 refreshToken 到 Vercel KV
    await kv.set(`user:${userId}`, { accessToken, refreshToken }, { ex: 7 * 24 * 60 * 60 }); // 7天过期

    // 关注@findom77230615
    await userClient.v2.follow(userId, TARGET_USER_ID);

    // 获取最新5条推文
    const client = new TwitterApi(BEARER_TOKEN);
    const tweets = await client.v2.userTimeline(TARGET_USER_ID, {
      max_results: 5,
      'tweet.fields': 'created_at',
      exclude: 'retweets,replies',
    });

    const tweetIds = tweets.data?.data || [];
    for (const tweet of tweetIds) {
      await userClient.v2.repost(userId, tweet.id);
      await userClient.v2.like(userId, tweet.id);
    }

    // 清理 auth 数据
    await kv.del(`auth:${sessionId}`);
    res.redirect(`/success?userId=${userId}`);
  } catch (error) {
    console.error('Callback error:', error);
    res.status(500).json({ error: 'Auth failed', details: error.message });
  }
});

// 每天凌晨3点检查前一天推文（为所有授权用户处理）
app.get('/api/daily-check', async (req, res) => {
  const client = new TwitterApi(BEARER_TOKEN);

  try {
    // 获取前一天推文
    const yesterdayStart = DateTime.now().minus({ days: 1 }).startOf('day').toISO();
    const yesterdayEnd = DateTime.now().minus({ days: 1 }).endOf('day').toISO();
    const tweets = await client.v2.userTimeline(TARGET_USER_ID, {
      max_results: 10,
      'tweet.fields': 'created_at',
      exclude: 'retweets,replies',
      start_time: yesterdayStart,
      end_time: yesterdayEnd,
    });

    const tweetIds = tweets.data?.data || [];
    if (tweetIds.length === 0) {
      return res.json({ processed: 0, message: 'No tweets found for yesterday' });
    }

    // 获取所有授权用户
    const userKeys = await kv.keys('user:*');
    let processedCount = 0;

    for (const key of userKeys) {
      const userId = key.split(':')[1];
      const userData = await kv.get(key);
      if (!userData?.accessToken) continue;

      const userClient = new TwitterApi({ accessToken: userData.accessToken });

      // 检查 token 是否有效
      try {
        await userClient.v2.me();
      } catch (error) {
        console.error(`Invalid token for user ${userId}:`, error);
        continue; // 跳过失效 token
      }

      // 为该用户点赞/转发
      for (const tweet of tweetIds) {
        try {
          await userClient.v2.repost(userId, tweet.id);
          await userClient.v2.like(userId, tweet.id);
          processedCount++;
        } catch (error) {
          console.error(`Error processing tweet ${tweet.id} for user ${userId}:`, error);
        }
      }
    }

    res.json({ processed: processedCount, tweets: tweetIds.length });
  } catch (error) {
    console.error('Daily check error:', error);
    res.status(500).json({ error: 'Daily check failed', details: error.message });
  }
});

module.exports = app;