const express = require('express');
const axios = require('axios');
const OAuth = require('oauth-1.0a');
const crypto = require('crypto');
const querystring = require('querystring');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// X API 凭证（通过环境变量获取）
const consumer_key = process.env.X_API_KEY;
const consumer_secret = process.env.X_API_SECRET;
const callback_url = process.env.CALLBACK_URL; // 使用环境变量 CALLBACK_URL

// 初始化 OAuth
const oauth = OAuth({
  consumer: { key: consumer_key, secret: consumer_secret },
  signature_method: 'HMAC-SHA1',
  hash_function(base_string, key) {
    return crypto.createHmac('sha1', key).update(base_string).digest('base64');
  },
});

// 图片 URL
const imageUrl = 'https://i.postimg.cc/BSYB7WCj/GQr-QAj-Jbg-AA-ogm.jpg';

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

// 路由：发起 OAuth 认证
app.get('/api/auth', async (req, res) => {
  try {
    // 检查环境变量
    if (!consumer_key || !consumer_secret || !callback_url) {
      return res.status(500).send('环境变量未设置：请检查 X_API_KEY, X_API_SECRET, CALLBACK_URL 在 Vercel 中');
    }

    const request_data = {
      url: 'https://api.x.com/1.1/oauth/request_token',
      method: 'POST',
      data: { oauth_callback: callback_url },
    };

    const response = await axios({
      url: request_data.url,
      method: request_data.method,
      headers: oauth.toHeader(oauth.authorize(request_data)),
    });

    const token_data = querystring.parse(response.data);
    res.redirect(`https://api.x.com/oauth/authenticate?oauth_token=${token_data.oauth_token}`);
  } catch (error) {
    console.error('Error in /auth:', error.response?.data || error.message);
    if (error.response?.status === 401) {
      res.status(500).send('认证失败：API 密钥无效或签名错误。请检查 X_API_KEY 和 X_API_SECRET');
    } else if (error.response?.status === 400) {
      res.status(500).send('认证失败：回调 URL 无效。请检查 CALLBACK_URL 和 X Developer Portal 设置');
    } else {
      res.status(500).send('认证失败：' + (error.response?.data?.errors?.[0]?.message || error.message));
    }
  }
});

// 路由：处理 OAuth 回调
app.get('/api/callback', async (req, res) => {
  const { oauth_token, oauth_verifier } = req.query;

  if (!oauth_token || !oauth_verifier) {
    return res.status(400).send('缺少授权参数');
  }

  try {
    // 获取访问令牌
    const token_request_data = {
      url: 'https://api.x.com/1.1/oauth/access_token',
      method: 'POST',
      data: { oauth_verifier },
    };

    const oauth_token_obj = { key: oauth_token, secret: '' }; // 临时 secret 为空
    const token_response = await axios({
      url: token_request_data.url,
      method: token_request_data.method,
      headers: oauth.toHeader(oauth.authorize(token_request_data, oauth_token_obj)),
    });

    const access_token_data = querystring.parse(token_response.data);
    const access_token = {
      key: access_token_data.oauth_token,
      secret: access_token_data.oauth_token_secret,
    };

    // 上传媒体并获取 media_id
    const media_id = await uploadMedia(imageUrl, access_token);

    // 发布带图片的推文（v2 API，符合手册）
    const tweet_data = {
      url: 'https://api.x.com/2/tweets',
      method: 'POST',
      data: {
        text: '看看这张图片！',
        media: {
          media_ids: [media_id], // 数组形式，符合 v2 要求
        },
      },
    };

    const tweet_response = await axios({
      url: tweet_data.url,
      method: tweet_data.method,
      headers: {
        ...oauth.toHeader(oauth.authorize(tweet_data, access_token)),
        'Content-Type': 'application/json', // v2 需要 JSON
      },
      data: JSON.stringify(tweet_data.data), // v2 需要 JSON 体
    });

    console.log('Tweet posted:', tweet_response.data);
    res.send('推文发布成功！帖子 ID: ' + tweet_response.data.data.id);
  } catch (error) {
    console.error('Error in /callback:', error.response?.data || error.message);
    res.status(500).send('发布推文失败：' + (error.response?.data?.errors?.[0]?.message || error.message));
  }
});

// 上传图片到 X（使用 v2 chunked upload 端点）
async function uploadMedia(imageUrl, access_token) {
  try {
    // 下载图片
    const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const imageBuffer = Buffer.from(imageResponse.data);
    const totalBytes = imageBuffer.length;

    if (totalBytes > 5 * 1024 * 1024) { // 5MB 限制
      throw new Error('图片太大，超过 5MB');
    }

    // 步骤 1: 初始化上传（v2: POST /2/media/upload/initialize）
    const init_data = {
      url: 'https://api.x.com/2/media/upload/initialize',
      method: 'POST',
      data: {
        media_type: 'image/jpeg', // 根据图片类型调整
        total_bytes: totalBytes,
        media_category: 'tweet_image', // 手册推荐用于帖子图片
      },
    };

    const init_response = await axios({
      url: init_data.url,
      method: init_data.method,
      headers: {
        ...oauth.toHeader(oauth.authorize(init_data, access_token)),
        'Content-Type': 'application/json',
      },
      data: JSON.stringify(init_data.data),
    });

    const upload_id = init_response.data.upload_id; // v2 返回 upload_id

    if (!upload_id) {
      throw new Error('初始化失败：未获取到 upload_id');
    }

    // 步骤 2: 追加媒体数据（v2: POST /2/media/upload/{upload_id}/append）
    const append_data = {
      url: `https://api.x.com/2/media/upload/${upload_id}/append`,
      method: 'POST',
      headers: {
        ...oauth.toHeader(oauth.authorize({
          url: append_data.url,
          method: append_data.method,
        }, access_token)),
        'Content-Type': 'application/octet-stream',
      },
      data: imageBuffer,
    };

    const append_response = await axios(append_data);

    if (append_response.status !== 200 && append_response.status !== 204) {
      throw new Error('追加失败：' + (append_response.data?.errors?.[0]?.message || '未知错误'));
    }

    // 步骤 3: 最终化上传（v2: POST /2/media/upload/{upload_id}/finalize）
    const finalize_data = {
      url: `https://api.x.com/2/media/upload/${upload_id}/finalize`,
      method: 'POST',
      headers: oauth.toHeader(oauth.authorize(finalize_data, access_token)),
    };

    const finalize_response = await axios(finalize_data);

    const media_id = finalize_response.data.media_id_string; // v2 返回 media_id_string

    if (!media_id) {
      throw new Error('最终化失败：未获取到 media_id');
    }

    // 可选: 检查处理状态（小图片通常无需轮询）
    if (finalize_response.data.processing_info) {
      const state = finalize_response.data.processing_info.state;
      console.log('媒体处理状态：', state);
      if (state !== 'succeeded') {
        throw new Error('媒体处理未完成，状态：' + state);
      }
    }

    return media_id;
  } catch (error) {
    console.error('Error uploading media (v2):', error.response?.data || error.message);
    throw new Error('媒体上传失败：' + (error.response?.data?.errors?.[0]?.message || error.message));
  }
}

// 启动服务器
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

module.exports = app;