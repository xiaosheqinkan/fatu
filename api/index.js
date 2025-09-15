const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const querystring = require('querystring');
const FormData = require('form-data');  // 新增：用于 multipart

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// X API 凭证（通过环境变量获取）
const client_id = process.env.X_CLIENT_ID;
const callback_url = process.env.CALLBACK_URL;

// 图片 URL
const imageUrl = 'https://i.postimg.cc/BSYB7WCj/GQr-QAj-Jbg-AA-ogm.jpg';

// 生成 PKCE 代码对（不变）
function generatePKCE() {
  const code_verifier = crypto.randomBytes(32).toString('base64url');
  const code_challenge = crypto
    .createHash('sha256')
    .update(code_verifier)
    .digest('base64url');
  return { code_verifier, code_challenge };
}

const codeVerifiers = new Map();

// 根路径和 /api/auth（不变，省略以节省空间）

// 修改：上传媒体（v2 chunked，使用 OAuth 2.0 Bearer Token）
async function uploadMedia(access_token) {
  try {
    // 下载图片
    const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const imageBuffer = Buffer.from(imageResponse.data);
    const totalBytes = imageBuffer.length;

    if (totalBytes > 5 * 1024 * 1024) {
      throw new Error('图片太大，超过 5MB');
    }

    console.log('Starting v2 chunked media upload with OAuth 2.0...');
    const media_type = 'image/jpeg';  // 根据实际调整
    const chunkSize = 5 * 1024 * 1024;  // 5MB chunks
    const numChunks = Math.ceil(totalBytes / chunkSize);

    // 步骤 1: INIT
    const initForm = new FormData();
    initForm.append('command', 'INIT');
    initForm.append('media_type', media_type);
    initForm.append('total_bytes', totalBytes.toString());
    initForm.append('media_category', 'tweet_image');

    const initResponse = await axios.post('https://api.x.com/2/media/upload', initForm, {
      headers: {
        ...initForm.getHeaders(),
        Authorization: `Bearer ${access_token}`,
      },
    });

    const media_id = initResponse.data.media_id_string;
    console.log('Upload initialized, Media ID:', media_id);

    if (!media_id) {
      throw new Error('INIT 失败：未获取到 media_id');
    }

    // 步骤 2: APPEND（分块上传，对于小文件可单块）
    for (let i = 0; i < numChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, totalBytes);
      const chunk = imageBuffer.slice(start, end);

      const appendForm = new FormData();
      appendForm.append('command', 'APPEND');
      appendForm.append('media_id', media_id);
      appendForm.append('segment_index', i.toString());
      appendForm.append('media', chunk, { filename: 'chunk.jpg', contentType: media_type });

      const appendResponse = await axios.post(`https://api.x.com/2/media/upload/${media_id}/append`, appendForm, {
        headers: {
          ...appendForm.getHeaders(),
          Authorization: `Bearer ${access_token}`,
        },
      });

      if (appendResponse.status !== 200 && appendResponse.status !== 204) {
        throw new Error(`APPEND 失败 (chunk ${i}): ${appendResponse.data?.errors?.[0]?.message || '未知错误'}`);
      }
      console.log(`Chunk ${i + 1}/${numChunks} uploaded`);
    }

    // 步骤 3: FINALIZE
    const finalizeForm = new FormData();
    finalizeForm.append('command', 'FINALIZE');
    finalizeForm.append('media_id', media_id);

    let finalizeResponse = await axios.post('https://api.x.com/2/media/upload', finalizeForm, {
      headers: {
        ...finalizeForm.getHeaders(),
        Authorization: `Bearer ${access_token}`,
      },
    });

    // 如果需要处理，轮询 STATUS
    if (finalizeResponse.data.processing_info) {
      console.log('Processing needed, state:', finalizeResponse.data.processing_info.state);
      while (finalizeResponse.data.processing_info.state === 'pending' || finalizeResponse.data.processing_info.state === 'in_progress') {
        await new Promise(resolve => setTimeout(resolve, 5000));  // 5s 轮询
        const statusResponse = await axios.get(`https://api.x.com/2/media/upload?command=STATUS&media_id=${media_id}`, {
          headers: { Authorization: `Bearer ${access_token}` },
        });
        finalizeResponse = statusResponse.data;
        if (finalizeResponse.processing_info.state === 'failed') {
          throw new Error('处理失败：' + finalizeResponse.processing_info.state);
        }
      }
      if (finalizeResponse.processing_info.state === 'succeeded') {
        console.log('Processing succeeded');
      }
    }

    return media_id;
  } catch (error) {
    console.error('Error in v2 media upload:', error.response?.data || error.message);
    if (error.response?.status === 401) {
      throw new Error('401 Unauthorized：确认 scope 包含 media.write，且 access_token 有效。检查 X Developer Portal 的 app 权限（Elevated/Basic 层级）');
    } else {
      throw new Error('媒体上传失败：' + (error.response?.data?.errors?.[0]?.message || error.message));
    }
  }
}

// /api/callback（微调：使用新 uploadMedia）
app.get('/api/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    return res.status(400).send(`授权失败：${error} - ${error_description}`);
  }

  if (!code || !state) {
    return res.status(400).send('缺少授权参数');
  }

  const code_verifier = codeVerifiers.get(state);
  if (!code_verifier) {
    return res.status(400).send('无效 state');
  }
  codeVerifiers.delete(state);

  try {
    const token_response = await axios.post('https://api.x.com/2/oauth2/token', querystring.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callback_url,
      client_id,
      code_verifier,
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const access_token = token_response.data.access_token;
    console.log('Access token acquired');

    // 上传媒体（v2 + OAuth 2.0）
    const media_id = await uploadMedia(access_token);

    // 发布推文
    const tweet_response = await axios.post('https://api.x.com/2/tweets', {
      text: '看看这张图片！',
      media: { media_ids: [media_id] },
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
    res.status(500).send('发布失败：' + (error.response?.data?.errors?.[0]?.message || error.message));
  }
});

// 启动服务器（不变）
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

module.exports = app;