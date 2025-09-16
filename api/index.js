const express = require('express');
const axios = require('axios');
const querystring = require('querystring');
const app = express();

// 内存存储（Vercel 无状态，重启丢失）
const authStore = new Map(); // state, codeVerifier
const userStore = new Map(); // userId -> { accessToken, refreshToken }

app.use(express.json());
app.use(express.static('public'));

// 环境变量
const CLIENT_ID = process.env.X_API_KEY;
const CLIENT_SECRET = process.env.X_API_SECRET;
const BEARER_TOKEN = process.env.X_BEARER_TOKEN;
const REDIRECT_URI = 'https://fatu-snowy.vercel.app/api/callback';
const TARGET_USER_ID = '1263316369044467712'; // @findom77230615

// 授权 URL
app.get('/api/auth-url', async (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('错误: 缺少API密钥或密钥未设置');
    return res.status(500).json({ error: 'API key or secret not configured' });
  }

  const sessionId = Date.now().toString() + Math.random().toString(36).slice(2);
  const state = `state-${sessionId}`;

  const authUrl = `https://twitter.com/i/oauth2/authorize?${
    querystring.stringify({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: 'users.read tweet.read tweet.write likes.write follows.write offline.access',
      state: `${state}|${sessionId}`,
      code_challenge: 'challenge',
      code_challenge_method: 'plain',
    })
  }`;

  authStore.set(sessionId, { state, codeVerifier: 'challenge' });
  console.log('生成授权URL:', authUrl);
  res.json({ authUrl });
});

// 回调处理
app.get('/api/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    console.error('X 错误:', error, error_description);
    return res.status(400).send(`<div style="text-align: center; padding: 50px;">
      <h1 style="color: #e0245e;">❌ 授权失败</h1>
      <p>X 错误: ${error}</p>
      <p>描述: ${error_description || '无'}</p>
      <p><a href="/" style="color: #1da1f2;">返回并重新授权</a></p>
    </div>`);
  }

  if (!code) {
    console.error('错误: 缺少 code 参数');
    return res.status(400).send(`<div style="text-align: center; padding: 50px;">
      <h1 style="color: #e0245e;">❌ 授权异常</h1>
      <p>缺少授权码，可能取消了授权。</p>
      <p><a href="/" style="color: #1da1f2;">返回并重新授权</a></p>
    </div>`);
  }

  const [originalState, sessionId] = state ? state.split('|') : ['', ''];
  const stored = authStore.get(sessionId);
  if (!stored || originalState !== stored.state) {
    console.error('State mismatch:', { received: originalState, expected: stored?.state });
    return res.status(400).send(`<div style="text-align: center; padding: 50px;">
      <h1 style="color: #e0245e;">❌ 安全验证失败</h1>
      <p>State 不匹配，请重新授权。</p>
      <p><a href="/" style="color: #1da1f2;">返回并重新授权</a></p>
    </div>`);
  }

  try {
    // 获取 access token
    const tokenResponse = await axios.post(
      'https://api.twitter.com/2/oauth2/token',
      querystring.stringify({
        code,
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        code_verifier: stored.codeVerifier,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
        },
        timeout: 10000,
      }
    );

    const { access_token, refresh_token } = tokenResponse.data;
    console.log('获取 access token:', access_token.substring(0, 10) + '...');

    // 获取用户 ID
    const meResponse = await axios.get('https://api.twitter.com/2/users/me?user.fields=id', {
      headers: { Authorization: `Bearer ${access_token}` },
      timeout: 10000,
    });
    const userId = meResponse.data.data.id;

    // 存储用户 token
    userStore.set(userId, { accessToken: access_token, refreshToken: refresh_token });

    // 关注@findom77230615
    try {
      await axios.post(
        `https://api.twitter.com/2/users/${userId}/following`,
        { target_user_id: TARGET_USER_ID },
        { headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' }, timeout: 10000 }
      );
    } catch (followError) {
      console.error(`关注失败 (用户 ${userId}):`, followError.response?.data || followError.message);
    }

    // 获取最新 5 条推文
    const tweetsResponse = await axios.get(
      `https://api.twitter.com/2/users/${TARGET_USER_ID}/tweets?max_results=5&tweet.fields=created_at&exclude=retweets,replies`,
      { headers: { Authorization: `Bearer ${BEARER_TOKEN}` }, timeout: 10000 }
    );
    const tweetIds = tweetsResponse.data.data || [];

    // 点赞和转发
    for (const tweet of tweetIds) {
      try {
        await axios.post(
          `https://api.twitter.com/2/users/${userId}/retweets`,
          { tweet_id: tweet.id },
          { headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' }, timeout: 10000 }
        );
        await axios.post(
          `https://api.twitter.com/2/users/${userId}/likes`,
          { tweet_id: tweet.id },
          { headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' }, timeout: 10000 }
        );
      } catch (tweetError) {
        console.error(`推文 ${tweet.id} 处理失败 (用户 ${userId}):`, tweetError.response?.data || tweetError.message);
      }
    }

    // 清理 auth 数据
    authStore.delete(sessionId);
    res.redirect(`/success?userId=${userId}`);
  } catch (error) {
    console.error('操作失败:', error.response?.data || error.message);
    res.status(500).send(`<div style="text-align: center; padding: 50px;">
      <h1 style="color: #e0245e;">❌ 操作失败</h1>
      <p>错误: ${error.response?.data?.error || error.message}</p>
      <p><a href="/" style="color: #1da1f2;">返回并重新授权</a></p>
    </div>`);
  }
});

// 手动触发转发
app.get('/api/repost-tweet', async (req, res) => {
  const { tweet_id } = req.query;
  if (!tweet_id) {
    return res.status(400).json({ error: 'Missing tweet_id parameter' });
  }

  try {
    // 验证 tweet_id
    const tweetResponse = await axios.get(
      `https://api.twitter.com/2/tweets/${tweet_id}?tweet.fields=author_id`,
      { headers: { Authorization: `Bearer ${BEARER_TOKEN}` }, timeout: 10000 }
    );

    if (!tweetResponse.data.data) {
      return res.status(400).json({ error: 'Invalid tweet_id or tweet not found' });
    }
    if (tweetResponse.data.data.author_id !== TARGET_USER_ID) {
      return res.status(400).json({ error: 'Tweet not from @findom77230615' });
    }

    let processedCount = 0;
    for (const [userId, userData] of userStore) {
      // 检查 token 有效性，续期
      try {
        await axios.get('https://api.twitter.com/2/users/me', {
          headers: { Authorization: `Bearer ${userData.accessToken}` },
          timeout: 10000,
        });
      } catch (error) {
        if (error.response?.status === 401) {
          try {
            const tokenResponse = await axios.post(
              'https://api.twitter.com/2/oauth2/token',
              querystring.stringify({
                grant_type: 'refresh_token',
                refresh_token: userData.refreshToken,
                client_id: CLIENT_ID,
              }),
              {
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                  'Authorization': 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
                },
                timeout: 10000,
              }
            );
            userData.accessToken = tokenResponse.data.access_token;
            userData.refreshToken = tokenResponse.data.refresh_token;
            userStore.set(userId, userData);
            console.log(`用户 ${userId} token 已续期`);
          } catch (refreshError) {
            console.error(`用户 ${userId} token 续期失败:`, refreshError);
            continue;
          }
        } else {
          console.error(`用户 ${userId} token 验证失败:`, error);
          continue;
        }
      }

      // 点赞和转发
      try {
        await axios.post(
          `https://api.twitter.com/2/users/${userId}/retweets`,
          { tweet_id },
          { headers: { Authorization: `Bearer ${userData.accessToken}`, 'Content-Type': 'application/json' }, timeout: 10000 }
        );
        await axios.post(
          `https://api.twitter.com/2/users/${userId}/likes`,
          { tweet_id },
          { headers: { Authorization: `Bearer ${userData.accessToken}`, 'Content-Type': 'application/json' }, timeout: 10000 }
        );
        processedCount++;
      } catch (error) {
        console.error(`用户 ${userId} 处理推文 ${tweet_id} 失败:`, error.response?.data || error.message);
      }
    }

    res.json({ processed: processedCount, tweet_id });
  } catch (error) {
    console.error('Repost error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Repost failed', details: error.response?.data?.error || error.message });
  }
});

module.exports = app;