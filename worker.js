// =================================================================================
//  项目: chat4o-2api (Cloudflare Worker 单文件版)
//  版本: 1.0.1 (代号: Chimera Synthesis - Auth Fix)
//  作者: 首席AI执行官 (Principal AI Executive Officer)
//  协议: 奇美拉协议 · 综合版 (Project Chimera: Synthesis Edition)
//  日期: 2025-11-24
//
//  描述:
//  本文件是一个完全自包含、可一键部署的 Cloudflare Worker。它将 chat4o.ai
//  的后端服务，无损地转换为一个高性能、兼容 OpenAI 标准的 API。
//
//  v1.0.1 修正:
//  1. [Critical] 修复 401 认证错误。已从 HAR 中提取 Authorization Bearer Token 并注入配置。
//  2. [Network] 完善了请求头伪装，确保通过上游校验。
// =================================================================================

// --- [第一部分: 核心配置 (Configuration-as-Code)] ---
const CONFIG = {
  // 项目元数据
  PROJECT_NAME: "chat4o-2api",
  PROJECT_VERSION: "1.0.1",
  
  // 安全配置 (建议在 Cloudflare 环境变量中设置 API_MASTER_KEY)
  API_MASTER_KEY: "1", 
  
  // 上游服务配置
  UPSTREAM_API_BASE: "https://api2.tap4.ai",
  ORIGIN_URL: "https://chat4o.ai",
  REFERER_URL: "https://chat4o.ai/",
  
  // --- [关键修正] 上游认证令牌 ---
  // 从您的抓包数据中提取的 Bearer Token
  TAP4_AI_TOKEN: "Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJsb2dpblR5cGUiOiJsb2dpbiIsImxvZ2luSWQiOiIwOjA6MTk5Mjg2NDg1OTc1MjcwMTk1MyIsInJuU3RyIjoiVVJ1aEwyem82aEdjck90RGNwMXhLUXhjS0JUNzVadzAiLCJjbGllbnRpZCI6IlVua25vd24iLCJ1c2VySWQiOjE5OTI4NjQ4NTk3NTI3MDE5NTN9.Z_XEPO_o8uwiG0re_IAxFLDBp6wvXTIrDNYfXdC8AY4",

  // 模型列表
  MODELS: [
    "gemini-2.0-flash-001"
  ],
  DEFAULT_MODEL: "gemini-2.0-flash-001",

  // 系统常量
  USER_AGENT: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"
};

// --- [第二部分: Worker 入口与路由] ---
export default {
  async fetch(request, env, ctx) {
    const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;
    const url = new URL(request.url);

    // 1. 预检请求 (CORS)
    if (request.method === 'OPTIONS') {
      return handleCorsPreflight();
    }

    // 2. 开发者驾驶舱 (Web UI)
    if (url.pathname === '/') {
      return handleUI(request, apiKey);
    } 
    // 3. API 路由
    else if (url.pathname.startsWith('/v1/')) {
      return handleApi(request, apiKey);
    } 
    // 4. 404
    else {
      return createErrorResponse(`路径未找到: ${url.pathname}`, 404, 'not_found');
    }
  }
};

// --- [第三部分: API 代理逻辑] ---

async function handleApi(request, apiKey) {
  // 鉴权
  const authHeader = request.headers.get('Authorization');
  if (apiKey && apiKey !== "1") {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return createErrorResponse('需要 Bearer Token 认证。', 401, 'unauthorized');
    }
    const token = authHeader.substring(7);
    if (token !== apiKey) {
      return createErrorResponse('无效的 API Key。', 403, 'invalid_api_key');
    }
  }

  const url = new URL(request.url);
  const requestId = `req-${crypto.randomUUID()}`;

  if (url.pathname === '/v1/models') {
    return handleModelsRequest();
  } else if (url.pathname === '/v1/chat/completions') {
    return handleChatCompletions(request, requestId);
  } else {
    return createErrorResponse(`不支持的 API 路径: ${url.pathname}`, 404, 'not_found');
  }
}

function handleModelsRequest() {
  const modelsData = {
    object: 'list',
    data: CONFIG.MODELS.map(modelId => ({
      id: modelId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'chat4o-2api',
    })),
  };
  return new Response(JSON.stringify(modelsData), {
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
  });
}

/**
 * 构造通用请求头 (包含 Authorization)
 */
function getCommonHeaders() {
  return {
    "authority": "api2.tap4.ai",
    "accept": "*/*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "authorization": CONFIG.TAP4_AI_TOKEN, // [关键修正] 注入 Token
    "content-type": "application/json",
    "origin": CONFIG.ORIGIN_URL,
    "referer": CONFIG.REFERER_URL,
    "user-agent": CONFIG.USER_AGENT,
    "sec-ch-ua": '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "cross-site"
  };
}

/**
 * 步骤1: 初始化会话 (addV3)
 */
async function initSession(model, firstContent) {
  const url = `${CONFIG.UPSTREAM_API_BASE}/chatbotSession/addV3`;
  const payload = {
    "site": "chat4o.ai",
    "firstContent": firstContent,
    "chatLogNum": "6",
    "llmModelName": model
  };

  const response = await fetch(url, {
    method: "POST",
    headers: getCommonHeaders(),
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`初始化会话失败: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  if (data.code !== 200 || !data.data || !data.data.sessionId) {
    // 如果 Token 失效，这里会返回 401 或其他错误码
    throw new Error(`上游返回无效的会话数据: ${JSON.stringify(data)}`);
  }

  return data.data.sessionId;
}

/**
 * 步骤2: 发送消息并获取流 (creditV2)
 */
async function sendChatRequest(sessionId, content, model) {
  const url = `${CONFIG.UPSTREAM_API_BASE}/chatbotLog/chat/stream/creditV2`;
  
  const userMsgId = `${Date.now()}-${crypto.randomUUID().substring(0, 8)}`;
  const assistantMsgId = `${Date.now()}-${crypto.randomUUID().substring(0, 8)}`;

  const payload = {
    "site": "chat4o.ai",
    "chatLogNum": "6",
    "content": content,
    "modelGrade": "common",
    "sessionId": sessionId,
    "userMessageTempId": userMsgId,
    "assistantMessageTempId": assistantMsgId
  };

  const response = await fetch(url, {
    method: "POST",
    headers: getCommonHeaders(),
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`发送消息失败: ${response.status} ${await response.text()}`);
  }

  return response;
}

async function handleChatCompletions(request, requestId) {
  try {
    const body = await request.json();
    const messages = body.messages || [];
    if (messages.length === 0) {
      return createErrorResponse("消息列表不能为空", 400, "invalid_request");
    }

    const lastUserMsg = messages.reverse().find(m => m.role === 'user');
    const prompt = lastUserMsg ? lastUserMsg.content : "Hello";
    const model = body.model || CONFIG.DEFAULT_MODEL;

    // 1. 初始化会话
    const sessionId = await initSession(model, prompt);

    // 2. 发送聊天请求
    const upstreamResponse = await sendChatRequest(sessionId, prompt, model);

    // 3. 处理流式响应
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    (async () => {
      try {
        const reader = upstreamResponse.body.getReader();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (line.startsWith('data:')) {
              const dataStr = line.slice(5).trim();
              if (!dataStr) continue;

              try {
                const json = JSON.parse(dataStr);
                if (json.code === 200 && json.data && json.data.content) {
                  const content = json.data.content;
                  
                  const chunk = {
                    id: requestId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: model,
                    choices: [{
                      index: 0,
                      delta: { content: content },
                      finish_reason: null
                    }]
                  };
                  await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
              } catch (e) {}
            }
          }
        }

        const endChunk = {
          id: requestId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: 'stop'
          }]
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
        await writer.write(encoder.encode('data: [DONE]\n\n'));

      } catch (e) {
        console.error("Stream processing error:", e);
        const errorChunk = {
          id: requestId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [{
            index: 0,
            delta: { content: `\n\n[Error: ${e.message}]` },
            finish_reason: 'stop'
          }]
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: corsHeaders({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Worker-Trace-ID': requestId
      })
    });

  } catch (e) {
    return createErrorResponse(e.message, 500, 'internal_error');
  }
}

function createErrorResponse(message, status, code) {
  return new Response(JSON.stringify({
    error: { message, type: 'api_error', code }
  }), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
  });
}

function handleCorsPreflight() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// --- [第四部分: 开发者驾驶舱 UI] ---
function handleUI(request, apiKey) {
  const origin = new URL(request.url).origin;
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${CONFIG.PROJECT_NAME} - 开发者驾驶舱</title>
    <style>
      :root { --bg: #121212; --panel: #1E1E1E; --border: #333; --text: #E0E0E0; --primary: #FFBF00; --accent: #007AFF; }
      body { font-family: 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); margin: 0; height: 100vh; display: flex; overflow: hidden; }
      .sidebar { width: 380px; background: var(--panel); border-right: 1px solid var(--border); padding: 20px; display: flex; flex-direction: column; overflow-y: auto; }
      .main { flex: 1; display: flex; flex-direction: column; padding: 20px; }
      
      .box { background: #252525; padding: 12px; border-radius: 6px; border: 1px solid var(--border); margin-bottom: 15px; }
      .label { font-size: 12px; color: #888; margin-bottom: 5px; display: block; }
      .code-block { font-family: monospace; font-size: 12px; color: var(--primary); word-break: break-all; background: #111; padding: 8px; border-radius: 4px; cursor: pointer; }
      
      input, select, textarea { width: 100%; background: #333; border: 1px solid #444; color: #fff; padding: 8px; border-radius: 4px; margin-bottom: 10px; box-sizing: border-box; }
      button { width: 100%; padding: 10px; background: var(--primary); border: none; border-radius: 4px; font-weight: bold; cursor: pointer; color: #000; }
      button:disabled { background: #555; cursor: not-allowed; }
      
      .chat-window { flex: 1; background: #000; border: 1px solid var(--border); border-radius: 8px; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 15px; }
      .msg { max-width: 80%; padding: 10px 15px; border-radius: 8px; line-height: 1.5; }
      .msg.user { align-self: flex-end; background: #333; color: #fff; }
      .msg.ai { align-self: flex-start; background: #1a1a1a; border: 1px solid #333; width: 100%; max-width: 100%; white-space: pre-wrap; }
      
      .status-bar { margin-top: 10px; font-size: 12px; color: #888; display: flex; justify-content: space-between; }
      .spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid #888; border-top-color: var(--primary); border-radius: 50%; animation: spin 1s linear infinite; margin-right: 5px; }
      @keyframes spin { to { transform: rotate(360deg); } }
      
      details { margin-top: 10px; }
      summary { cursor: pointer; color: #888; font-size: 12px; margin-bottom: 5px; }
      .guide-content { background: #222; padding: 10px; border-radius: 4px; font-size: 12px; color: #ccc; }
    </style>
</head>
<body>
    <div class="sidebar">
        <h2 style="margin-top:0">🤖 ${CONFIG.PROJECT_NAME} <span style="font-size:12px;color:#888">v${CONFIG.PROJECT_VERSION}</span></h2>
        
        <div class="box">
            <span class="label">API 密钥 (点击复制)</span>
            <div class="code-block" onclick="copy('${apiKey}')">${apiKey}</div>
        </div>

        <div class="box">
            <span class="label">API 接口地址</span>
            <div class="code-block" onclick="copy('${origin}/v1/chat/completions')">${origin}/v1/chat/completions</div>
        </div>

        <div class="box">
            <span class="label">模型</span>
            <select id="model">
                ${CONFIG.MODELS.map(m => `<option value="${m}">${m}</option>`).join('')}
            </select>
            
            <span class="label" style="margin-top:10px">提示词</span>
            <textarea id="prompt" rows="4" placeholder="输入对话内容..."></textarea>
            
            <button id="btn-gen" onclick="generate()">发送消息</button>
        </div>

        <details>
            <summary>⚙️ cURL 调用示例</summary>
            <div class="guide-content">
<pre style="white-space: pre-wrap; word-break: break-all;">
curl ${origin}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -d '{
    "model": "${CONFIG.DEFAULT_MODEL}",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
</pre>
            </div>
        </details>
    </div>

    <main class="main">
        <div class="chat-window" id="chat">
            <div style="color:#666; text-align:center; margin-top:50px;">
                Chat4O 代理服务就绪。<br>
                支持流式响应，兼容 OpenAI 格式。
            </div>
        </div>
    </main>

    <script>
        const API_KEY = "${apiKey}";
        const ENDPOINT = "${origin}/v1/chat/completions";
        
        function copy(text) {
            navigator.clipboard.writeText(text);
            alert('已复制');
        }

        function appendMsg(role, text) {
            const div = document.createElement('div');
            div.className = \`msg \${role}\`;
            div.innerText = text;
            document.getElementById('chat').appendChild(div);
            div.scrollIntoView({ behavior: "smooth" });
            return div;
        }

        async function generate() {
            const prompt = document.getElementById('prompt').value.trim();
            if (!prompt) return alert('请输入提示词');

            const btn = document.getElementById('btn-gen');
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner"></span> 发送中...';

            // 清空欢迎语
            if(document.querySelector('.chat-window').innerText.includes('代理服务就绪')) {
                document.getElementById('chat').innerHTML = '';
            }

            appendMsg('user', prompt);
            const aiMsg = appendMsg('ai', '...');
            let fullText = "";

            try {
                const res = await fetch(ENDPOINT, {
                    method: 'POST',
                    headers: { 
                        'Authorization': 'Bearer ' + API_KEY, 
                        'Content-Type': 'application/json' 
                    },
                    body: JSON.stringify({
                        model: document.getElementById('model').value,
                        messages: [{role: "user", content: prompt}],
                        stream: true
                    })
                });

                if (!res.ok) {
                    const err = await res.json();
                    throw new Error(err.error?.message || '请求失败');
                }

                const reader = res.body.getReader();
                const decoder = new TextDecoder();

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    const chunk = decoder.decode(value);
                    const lines = chunk.split('\\n');
                    
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const dataStr = line.slice(6);
                            if (dataStr === '[DONE]') break;
                            try {
                                const data = JSON.parse(dataStr);
                                const content = data.choices[0].delta.content;
                                if (content) {
                                    fullText += content;
                                    aiMsg.innerText = fullText;
                                    // 自动滚动
                                    document.getElementById('chat').scrollTop = document.getElementById('chat').scrollHeight;
                                }
                            } catch (e) {}
                        }
                    }
                }

            } catch (e) {
                aiMsg.innerHTML = \`<span style="color:#CF6679">❌ 错误: \${e.message}</span>\`;
            } finally {
                btn.disabled = false;
                btn.innerText = "发送消息";
                document.getElementById('prompt').value = '';
            }
        }
    </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
    },
  });
}
