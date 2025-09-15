const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const querystring = require('querystring');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// X API 凭证（通过环境变量获取）
const client_id = process.env.X_CLIENT_ID;
const callback_url = process.env.CALLBACK_URL; // https://fatu-snowy.vercel.app/api/callback

// 图片 URL
const imageUrl = 'https://i.postimg.cc/BSYB7WCj/GQr-QAj-Jbg-AA-ogm.jpg';

// 生成 PKCE 代码对
function generatePKCE() {
  const code_verifier = crypto.randomBytes(32).toString('base64url');
  const code_challenge = crypto
    .createHash('sha256')
    .update(code_verifier)
    .digest('base64url');
  return { code_verifier, code_challenge };
}

// 临时存储 code_verifier（生产环境建议用 Redis）
const codeVerifiers = new Map();

// 根路径：返回简单的 HTML 页面
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>X 发布应用</title>
    </head>
    <body>
      <h1>欢迎使用 X 发布应用</h1>
      <p>点击下方按钮授权并在 X 上发布图片</p>
      <a href="/api/auth">
        <button>授权 X</button>
      </a>
    </body>
    </html>
  `);
});

// 路由：发起 OAuth 2.0 PKCE 认证
app.get('/api/auth', async (req, res) => {
  try {
    // 检查环境变量
    if (!client_id || !callback_url) {
      return res.status(500).send('环境变量未设置：请检查 X_CLIENT_ID, CALLBACK_URL 在 Vercel 中');
    }

    // 生成 PKCE 代码
    const { code_verifier, code_challenge } = generatePKCE();
    const state = crypto.randomBytes(16).toString('hex'); // 防止 CSRF
    codeVerifiers.set(state, code_verifier); // 存储 code_verifier

    const authUrl = `https://x.com/i/oauth2/authorize?` +
      querystring.stringify({
        response_type: 'code',
        client_id,
        redirect_uri: callback_url,
        scope: 'tweet.write tweet.read users.read offline.access', // 移除 media.upload
        state,
        code_challenge,
        code_challenge_method: 'S256',
      });

    console.log('Redirecting to auth URL:', authUrl); // 调试
    res.redirect(authUrl);
  } catch (error) {
    console.error('Error in /auth:', error.message);
    res.status(500).send('认证失败：' + error.message + '。请检查 X Developer Portal 的 Client ID 和回调 URL');
  }
});

// 路由：处理 OAuth 2.0 回调
app.get('/api/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    console.error('OAuth error:', error, error_description);
    return res.status(400).send(`授权失败：${error} - ${error_description || '请检查 X Developer Portal 的权限和 scope'}`);
  }

  if (!code || !state) {
    return res.status(400).send('缺少授权参数：code 或 state');
  }

  const code_verifier = codeVerifiers.get(state);
  if (!code_verifier) {
    return res.status(400).send('无效 state 参数');
  }
  codeVerifiers.delete(state); // 清理

  try {
    // 交换访问令牌
    const token_response = await axios.post('https://api.x.com/2/oauth2/token', querystring.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callback_url,
      client_id,
      code_verifier,
    }), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    const access_token = token_response.data.access_token;
    console.log('Access token acquired:', access_token.substring(0, 10) + '...'); // 调试

    // 上传媒体并获取 media_id
    const media_id = await uploadMedia(imageUrl, access_token);

    // 发布带图片的推文（v2 API）
    const tweet_response = await axios.post('https://api.x.com/2/tweets', {
      text: '看看这张图片！',
      media: {
        media_ids: [media_id],
      },
    }, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Content-Type': 'application/json',
      },
    });

    console.log('Tweet posted:', tweet_response.data);
    res.send('推文发布成功！帖子 ID: ' + tweet_response.data.data.id);
  } catch (error) {
    console.error('Error in /callback:', error.response?.data || error.message);
    if (error.response?.status === 401) {
      res.status(500).send('发布推文失败：401 Unauthorized - 可能是权限不足（检查 Write 权限和 scope: tweet.write），或访问令牌无效。请确认 X Developer Portal 的应用层级和权限');
    } else {
      res.status(500).send('发布推文失败：' + (error.response?.data?.errors?.[0]?.message || error.message));
    }
  }
});

// 上传图片到 X（使用 v2 chunked upload 端点）
async function uploadMedia(imageUrl, access_token) {
  try {
    // 下载图片
    const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const imageBuffer = Buffer.from(imageResponse.data);
    const totalBytes = imageBuffer.length;

    if (totalBytes > 5 * 1024 * 1024) {
      throw new Error('图片太大，超过 5MB');
    }

    console.log('Starting media upload...'); // 调试
    // 步骤 1: 初始化上传
    const init_response = await axios.post('https://api.x.com/2/media/upload/initialize', {
      media_type: 'image/jpeg',
      total_bytes: totalBytes,
      media_category: 'tweet_image',
    }, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Content-Type': 'application/json',
      },
    });

    const upload_id = init_response.data.upload_id;
    console.log('Upload ID:', upload_id); // 调试

    if (!upload_id) {
      throw new Error('初始化失败：未获取到 upload_id');
    }

    // 步骤 2: 追加媒体数据
    const append_response = await axios.post(`https://api.x.com/2/media/upload/${upload_id}/append`, imageBuffer, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Content-Type': 'application/octet-stream',
      },
    });

    if (append_response.status !== 200 && append_response.status !== 204) {
      throw new Error('追加失败：' + (append_response.data?.errors?.[0]?.message || '未知错误'));
    }

    // 步骤 3: 最终化上传
    const finalize_response = await axios.post(`https://api.x.com/2/media/upload/${upload_id}/finalize`, {}, {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    });

    const media_id = finalize_response.data.media_id_string;
    console.log('Media ID:', media_id); // 调试

    if (!media_id) {
      throw new Error('最终化失败：未获取到 media_id');
    }

    if (finalize_response.data.processing_info) {
      console.log('媒体处理状态：', finalize_response.data.processing_info.state);
      if (finalize_response.data.processing_info.state !== 'succeeded') {
        throw new Error('媒体处理未完成，状态：' + finalize_response.data.processing_info.state);
      }
    }

    return media_id;
  } catch (error) {
    console.error('Error uploading media (v2):', error.response?.data || error.message);
    if (error.response?.status === 401) {
      throw new Error('媒体上传失败：401 Unauthorized - 可能是 Write 或 media.upload 权限缺失。请检查 X Developer Portal');
    } else {
      throw new Error('媒体上传失败：' + (error.response?.data?.errors?.[0]?.message || error.message));
    }
  }
}

// 启动服务器
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

module.exports = app;