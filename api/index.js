const express = require('express');
const axios = require('axios');
const querystring = require('querystring');
const app = express();

// 内存存储
const authStore = new Map();

app.use(express.json());
app.use(express.static('public'));

// 环境变量
const CLIENT_ID = process.env.X_API_KEY;
const CLIENT_SECRET = process.env.X_API_SECRET;
const REDIRECT_URI = 'https://fatu-snowy.vercel.app/api/callback';

// 授权 URL（只读 scopes）
app.get('/api/auth-url', async (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({ error: 'API key or secret not configured' });
  }

  const sessionId = Date.now().toString() + Math.random().toString(36).slice(2);
  const state = `state-${sessionId}`;

  const authUrl = `https://twitter.com/i/oauth2/authorize?${
    querystring.stringify({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: 'users.read offline.access',
      state: `${state}|${sessionId}`,
      code_challenge: 'challenge',
      code_challenge_method: 'plain',
    })
  }`;

  authStore.set(sessionId, { state, codeVerifier: 'challenge' });
  res.json({ authUrl });
});

// 回调处理（只获取用户信息）
app.get('/api/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    return res.status(400).send(`<div style="text-align: center; padding: 50px;">
      <h1 style="color: #e0245e;">❌ 授权失败</h1>
      <p>X 错误: ${error}</p>
      <p>描述: ${error_description || '无'}</p>
      <p><a href="/" style="color: #1da1f2;">返回重新授权</a></p>
    </div>`);
  }

  if (!code) {
    return res.status(400).send(`<div style="text-align: center; padding: 50px;">
      <h1 style="color: #e0245e;">❌ 授权异常</h1>
      <p>缺少授权码。</p>
      <p><a href="/" style="color: #1da1f2;">返回重新授权</a></p>
    </div>`);
  }

  const [originalState, sessionId] = state ? state.split('|') : ['', ''];
  const stored = authStore.get(sessionId);
  if (!stored || originalState !== stored.state) {
    return res.status(400).send(`<div style="text-align: center; padding: 50px;">
      <h1 style="color: #e0245e;">❌ 验证失败</h1>
      <p>State 不匹配，请重新授权。</p>
      <p><a href="/" style="color: #1da1f2;">返回重新授权</a></p>
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

    const { access_token } = tokenResponse.data;

    // 获取用户信息（测试授权）
    const meResponse = await axios.get('https://api.twitter.com/2/users/me?user.fields=id,username', {
      headers: { Authorization: `Bearer ${access_token}` },
      timeout: 10000,
    });

    const userId = meResponse.data.data.id;
    const username = meResponse.data.data.username;

    authStore.delete(sessionId);
    res.send(`<div style="text-align: center; padding: 50px;">
      <h1 style="color: #17bf63;">授权成功！</h1>
      <p>用户: @${username} (ID: ${userId})</p>
      <p>授权完成。如果需要关注功能，请升级 X API 计划。</p>
      <p><a href="/" style="color: #1da1f2;">返回首页</a></p>
    </div>`);
  } catch (error) {
    console.error('操作失败:', error.response?.data || error.message);
    res.status(500).send(`<div style="text-align: center; padding: 50px;">
      <h1 style="color: #e0245e;">❌ 操作失败</h1>
      <p>错误: ${error.response?.data?.error || error.message}</p>
      <p><a href="/" style="color: #1da1f2;">返回重新授权</a></p>
    </div>`);
  }
});

module.exports = app;