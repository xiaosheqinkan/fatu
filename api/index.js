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
const callback_url = 'https://your-vercel-app.vercel.app/api/callback'; // 替换为你的 Vercel 部署 URL

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

// 路由：发起 OAuth 认证
app.get('/api/auth', async (req, res) => {
  try {
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
    res.status(500).send('Authentication failed');
  }
});

// 路由：处理 OAuth 回调
app.get('/api/callback', async (req, res) => {
  const { oauth_token, oauth_verifier } = req.query;

  try {
    // 获取访问令牌
    const token_request_data = {
      url: 'https://api.x.com/1.1/oauth/access_token',
      method: 'POST',
      data: { oauth_verifier },
    };

    const oauth_token_obj = { key: oauth_token, secret: '' }; // 临时 secret 为空
    const response = await axios({
      url: token_request_data.url,
      method: token_request_data.method,
      headers: oauth.toHeader(oauth.authorize(token_request_data, oauth_token_obj)),
    });

    const access_token_data = querystring.parse(response.data);
    const access_token = {
      key: access_token_data.oauth_token,
      secret: access_token_data.oauth_token_secret,
    };

    // 发布带图片的推文
    const tweet_data = {
      url: 'https://api.x.com/2/tweets',
      method: 'POST',
      data: {
        text: 'Check out this image!',
        media: {
          media_ids: [await uploadMedia(imageUrl, access_token)],
        },
      },
    };

    const tweet_response = await axios({
      url: tweet_data.url,
      method: tweet_data.method,
      headers: oauth.toHeader(oauth.authorize(tweet_data, access_token)),
      data: tweet_data.data,
    });

    res.send('Tweet posted successfully!');
  } catch (error) {
    console.error('Error in /callback:', error.response?.data || error.message);
    res.status(500).send('Failed to post tweet');
  }
});

// 上传图片到 X
async function uploadMedia(imageUrl, access_token) {
  try {
    // 下载图片
    const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const imageBuffer = Buffer.from(imageResponse.data);

    // 初始化上传
    const init_data = {
      url: 'https://upload.x.com/1.1/media/upload.json?command=INIT&media_type=image/jpeg&total_bytes=' + imageBuffer.length,
      method: 'POST',
    };

    const init_response = await axios({
      url: init_data.url,
      method: init_data.method,
      headers: oauth.toHeader(oauth.authorize(init_data, access_token)),
    });

    const media_id = init_response.data.media_id_string;

    // 上传图片数据
    const append_data = {
      url: `https://upload.x.com/1.1/media/upload.json?command=APPEND&media_id=${media_id}&segment_index=0`,
      method: 'POST',
      data: imageBuffer,
      headers: {
        ...oauth.toHeader(oauth.authorize({ url: append_data.url, method: append_data.method }, access_token)),
        'Content-Type': 'application/octet-stream',
      },
    };

    await axios(append_data);

    // 完成上传
    const finalize_data = {
      url: `https://upload.x.com/1.1/media/upload.json?command=FINALIZE&media_id=${media_id}`,
      method: 'POST',
    };

    await axios({
      url: finalize_data.url,
      method: finalize_data.method,
      headers: oauth.toHeader(oauth.authorize(finalize_data, access_token)),
    });

    return media_id;
  } catch (error) {
    console.error('Error uploading media:', error.response?.data || error.message);
    throw error;
  }
}

// 启动服务器
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

module.exports = app;