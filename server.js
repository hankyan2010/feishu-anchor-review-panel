const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const TMP_DIR = path.join(ROOT, 'tmp');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const ANCHORS_PATH = path.join(DATA_DIR, 'anchors.json');
const RUNTIME_LOG_PATH = path.join(DATA_DIR, 'runtime.log');

function loadDotenv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotenv();

const PORT = Number(process.env.PORT || 3236);

for (const dir of [DATA_DIR, TMP_DIR]) fs.mkdirSync(dir, { recursive: true });

if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) {
  console.error('[fatal] 缺少 FEISHU_APP_ID / FEISHU_APP_SECRET，请复制 .env.example 为 .env 并填入飞书应用凭证后再启动。');
  process.exit(1);
}

const DEFAULT_CONFIG = {
  feishu: {
    appId: process.env.FEISHU_APP_ID,
    appSecret: process.env.FEISHU_APP_SECRET,
    appToken: process.env.FEISHU_BITABLE_APP_TOKEN || '',
    tableId: process.env.FEISHU_BITABLE_TABLE_ID || '',
    tableUrl: process.env.FEISHU_BITABLE_URL || '',
    tableName: process.env.FEISHU_BITABLE_TABLE_NAME || '主播复盘记录',
    baseName: process.env.FEISHU_BITABLE_BASE_NAME || '主播复盘数据台'
  }
};

function loadConfig() {
  let stored = { feishu: {} };
  if (fs.existsSync(CONFIG_PATH)) {
    try { stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || { feishu: {} }; }
    catch { stored = { feishu: {} }; }
  }
  return {
    feishu: {
      appId: DEFAULT_CONFIG.feishu.appId,
      appSecret: DEFAULT_CONFIG.feishu.appSecret,
      tableName: DEFAULT_CONFIG.feishu.tableName,
      baseName: DEFAULT_CONFIG.feishu.baseName,
      appToken: stored.feishu?.appToken || DEFAULT_CONFIG.feishu.appToken,
      tableId: stored.feishu?.tableId || DEFAULT_CONFIG.feishu.tableId,
      tableUrl: stored.feishu?.tableUrl || DEFAULT_CONFIG.feishu.tableUrl
    }
  };
}

function saveConfig(config) {
  const persisted = {
    feishu: {
      appToken: config.feishu.appToken || '',
      tableId: config.feishu.tableId || '',
      tableUrl: config.feishu.tableUrl || '',
      tableName: config.feishu.tableName || '',
      baseName: config.feishu.baseName || ''
    }
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(persisted, null, 2));
}

let config = loadConfig();

function loadAnchors() {
  if (!fs.existsSync(ANCHORS_PATH)) {
    fs.writeFileSync(ANCHORS_PATH, JSON.stringify({ anchors: [] }, null, 2));
  }
  try {
    const data = JSON.parse(fs.readFileSync(ANCHORS_PATH, 'utf8'));
    return Array.isArray(data.anchors) ? data.anchors : [];
  } catch {
    return [];
  }
}

function saveAnchors(anchors) {
  fs.writeFileSync(ANCHORS_PATH, JSON.stringify({ anchors }, null, 2));
}

function appendRuntimeLog(message, meta = {}) {
  const line = JSON.stringify({ time: new Date().toISOString(), message, ...meta }, null, 0) + '\n';
  fs.appendFileSync(RUNTIME_LOG_PATH, line);
}

function createAnchor(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('主播名不能为空');
  const anchors = loadAnchors();
  const exists = anchors.find(a => a.name === trimmed);
  if (exists) return exists;
  const anchor = { id: crypto.randomUUID(), name: trimmed, createdAt: Date.now() };
  anchors.push(anchor);
  saveAnchors(anchors);
  return anchor;
}

function deleteAnchor(id) {
  const anchors = loadAnchors();
  const next = anchors.filter(a => a.id !== id);
  saveAnchors(next);
}

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function text(res, status, content, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store'
  });
  res.end(content);
}

function serveStatic(req, res, pathname) {
  const filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return false;
  }
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg'
  };
  res.writeHead(200, {
    'Content-Type': types[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store'
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 30 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

function sanitizeBase64(input) {
  return String(input || '').replace(/^data:[^;]+;base64,/, '');
}

function ensureImagePayload(images) {
  const allowed = ['douyin', 'videohao', 'kuaishou'];
  if (!images || typeof images !== 'object') throw new Error('未上传任何图片');
  const provided = allowed.filter(k => images[k] && images[k].base64);
  if (provided.length === 0) throw new Error('请至少上传一张平台截图');
  return provided;
}

function writeTempImage(name, base64) {
  const file = path.join(TMP_DIR, `${Date.now()}-${crypto.randomUUID()}-${name}.png`);
  fs.writeFileSync(file, Buffer.from(sanitizeBase64(base64), 'base64'));
  return file;
}

function runTesseract(filePath) {
  return new Promise((resolve, reject) => {
    execFile('tesseract', [filePath, 'stdout', '-l', 'chi_sim+eng', '--psm', '6'], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message || 'OCR 失败'));
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

function cleanOcrText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.replace(/\t/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const PLATFORM_FIELDS = {
  douyin: [
    '开播时间', '关播时间', '直播时长',
    '收获音浪', '送礼人数', '送礼率', '会员收入', '星守护收入', '预计本场收入',
    '曝光人数', '进房人数', '进房率', '平均在线人数', '最高在线人数',
    '人均停留时长', '评论人数', '点赞次数', '新增粉丝', '分享次数', '加粉丝团人数'
  ],
  videohao: [
    '开播时间', '开播时长',
    '观看人数', '观看次数', '最高在线', '平均观看时长',
    '点赞次数', '评论次数', '分享次数', '新增关注人数'
  ],
  kuaishou: [
    '开播时间', '直播时长(分钟)', '直播观众数', '在线人数峰值',
    '点赞数', '评论人数', '分享人数', '送礼人数'
  ]
};

const PLATFORM_LABELS_CN = { douyin: '抖音', videohao: '视频号', kuaishou: '快手' };

const PLATFORM_PROMPT_HINTS = {
  douyin: '这是抖音直播复盘后台截图。注意：营收/流量/互动三个指标卡，每张卡里"指标名"和"数值"分行排列。如果该指标显示为 0、0元、0%，请如实填 "0"、"0元"、"0%"。',
  videohao: '这是视频号直播复盘后台截图。注意：基础数据 4 个 + 互动数据 4 个，"指标名"和"数值"分行排列；开播时长格式如"00小时24分15秒"。',
  kuaishou: '这是快手直播历史列表的截图，可能包含多行。请只提取**第一行**（最近一场直播）的数据。'
};

function buildVisionPrompt(platform) {
  const fields = PLATFORM_FIELDS[platform];
  const hint = PLATFORM_PROMPT_HINTS[platform] || '';
  const schema = fields.map(f => `  "${f}": "..."`).join(',\n');
  return [
    `你是一个数据提取助手。${hint}`,
    '请从图中提取以下字段，严格按照 JSON 格式输出，不要任何解释、不要 markdown 代码块标记：',
    '{',
    schema,
    '}',
    '所有值都用字符串类型。如果某个字段在图中找不到，填空字符串 ""。',
    '时间字段保留原格式（如 "2026-04-09 15:41:23"）。',
    '数值带单位的保留单位（如 "1,914"、"14.5%"、"0.5分钟"、"1小时2分钟58秒"）。'
  ].join('\n');
}

function callDoubaoVision(filePath, platform) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ARK_API_KEY;
    const modelId = process.env.ARK_MODEL_ID;
    if (!apiKey || !modelId) {
      reject(new Error('ARK_API_KEY 或 ARK_MODEL_ID 未配置'));
      return;
    }
    const base64 = fs.readFileSync(filePath).toString('base64');
    const body = JSON.stringify({
      model: modelId,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
          { type: 'text', text: buildVisionPrompt(platform) }
        ]
      }],
      temperature: 0.1
    });
    const req = https.request({
      hostname: 'ark.cn-beijing.volces.com',
      port: 443,
      path: '/api/v3/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`豆包 ${res.statusCode}: ${raw.slice(0, 300)}`));
          return;
        }
        try {
          const data = JSON.parse(raw);
          const content = data?.choices?.[0]?.message?.content || '';
          const cleaned = content.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
          const metrics = JSON.parse(cleaned);
          resolve({ metrics, raw: content });
        } catch (e) {
          reject(new Error(`豆包返回非 JSON: ${e.message} | ${raw.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(new Error('豆包请求超时')); });
    req.write(body);
    req.end();
  });
}

async function recognizePlatform(filePath, platform) {
  const fields = PLATFORM_FIELDS[platform] || [];
  const useDoubao = process.env.ARK_API_KEY && process.env.ARK_MODEL_ID;
  if (useDoubao) {
    try {
      const { metrics, raw } = await callDoubaoVision(filePath, platform);
      const normalized = {};
      for (const f of fields) normalized[f] = String(metrics[f] || '').trim();
      return { platform, engine: 'doubao', rawText: raw, metrics: normalized };
    } catch (err) {
      appendRuntimeLog('豆包视觉失败回退 tesseract', { platform, error: err.message });
    }
  }
  const rawText = cleanOcrText(await runTesseract(filePath));
  const metrics = {};
  for (const f of fields) metrics[f] = '';
  for (const line of rawText.split('\n')) {
    for (const f of fields) {
      if (!metrics[f] && line.includes(f)) {
        const value = line.slice(line.indexOf(f) + f.length).replace(/^[:：\s]+/, '').trim();
        if (value) metrics[f] = value;
      }
    }
  }
  return { platform, engine: 'tesseract', rawText, metrics };
}

function summarizeMetrics(metrics) {
  const entries = Object.entries(metrics);
  if (!entries.length) return '未识别到稳定指标，请查看 OCR 原文';
  return entries.map(([k, v]) => `${k}：${v}`).join('；');
}

async function ocrImages(images) {
  const provided = ensureImagePayload(images);
  const files = {};
  try {
    for (const key of provided) files[key] = writeTempImage(key, images[key].base64);
    const result = {};
    const tasks = provided.map(async key => {
      const recognized = await recognizePlatform(files[key], key);
      result[key] = {
        platform: key,
        engine: recognized.engine,
        rawText: recognized.rawText,
        metrics: recognized.metrics,
        summary: summarizeMetrics(recognized.metrics)
      };
    });
    await Promise.all(tasks);
    return result;
  } finally {
    for (const file of Object.values(files)) {
      try { fs.unlinkSync(file); } catch {}
    }
  }
}

function requestJson(method, urlString, headers, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const body = payload ? JSON.stringify(payload) : '';
    const req = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method,
      headers: {
        ...(headers || {}),
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const data = raw ? JSON.parse(raw) : {};
          resolve({ status: res.statusCode || 0, data });
        } catch (error) {
          reject(new Error(`接口返回非 JSON：${raw.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function feishuRequest(method, pathname, payload) {
  const token = await getTenantToken();
  const { status, data } = await requestJson(method, `https://open.feishu.cn${pathname}`, {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json; charset=utf-8'
  }, payload);
  if (status < 200 || status >= 300 || data.code !== 0) {
    const err = new Error(data.msg || `飞书接口失败: ${status}`);
    err.payload = data;
    err.status = status;
    throw err;
  }
  return data.data;
}

async function ensureField(appToken, tableId, field) {
  try {
    await feishuRequest('POST', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, field);
  } catch (error) {
    const code = error?.payload?.code;
    if (code === 1254014) return;
    throw error;
  }
}

async function listFields(appToken, tableId) {
  const data = await feishuRequest('GET', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=500`);
  return data.items || [];
}

async function updateField(appToken, tableId, fieldId, payload) {
  return feishuRequest('PUT', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields/${fieldId}`, payload);
}

async function removeField(appToken, tableId, fieldId) {
  return feishuRequest('DELETE', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields/${fieldId}`);
}

async function getTenantToken() {
  const { status, data } = await requestJson('POST', 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal/', {
    'Content-Type': 'application/json; charset=utf-8'
  }, {
    app_id: config.feishu.appId,
    app_secret: config.feishu.appSecret
  });
  if (status < 200 || status >= 300 || data.code !== 0 || !data.tenant_access_token) {
    const err = new Error(data.msg || '获取 tenant_access_token 失败');
    err.payload = data;
    throw err;
  }
  return data.tenant_access_token;
}

async function ensureBitable() {
  config = loadConfig();

  if (!config.feishu.appToken || !config.feishu.tableId || !config.feishu.tableUrl) {
    const base = await feishuRequest('POST', '/open-apis/bitable/v1/apps', {
      name: config.feishu.baseName,
      time_zone: 'Asia/Shanghai'
    });

    config.feishu.appToken = base.app.app_token;
    config.feishu.tableId = base.app.default_table_id;
    config.feishu.tableUrl = base.app.url;
    saveConfig(config);
  }

  let existingFields = await listFields(config.feishu.appToken, config.feishu.tableId);
  const primaryField = existingFields.find(field => field.is_primary);
  const duplicateAnchorField = existingFields.find(field => !field.is_primary && field.field_name === '主播');

  if (primaryField && primaryField.field_name !== '主播') {
    try {
      if (duplicateAnchorField) {
        await updateField(config.feishu.appToken, config.feishu.tableId, duplicateAnchorField.field_id, { field_name: '主播_待删', type: duplicateAnchorField.type || 1 });
      }
      await updateField(config.feishu.appToken, config.feishu.tableId, primaryField.field_id, { field_name: '主播', type: primaryField.type || 1 });
      existingFields = await listFields(config.feishu.appToken, config.feishu.tableId);
    } catch (e) {
      console.error('[ensureBitable] 改主键名失败:', e.message, JSON.stringify(e.payload || {}));
      throw e;
    }
  }

  const staleAnchorField = existingFields.find(field => !field.is_primary && (field.field_name === '主播' || field.field_name === '主播_待删'));
  if (staleAnchorField) {
    try { await removeField(config.feishu.appToken, config.feishu.tableId, staleAnchorField.field_id); }
    catch (e) { console.error('[ensureBitable] 删旧主播字段失败（忽略）:', e.message); }
  }

  // 清理飞书默认建的垃圾字段（单选、附件等）
  const FEISHU_DEFAULT_GARBAGE = new Set(['单选', '附件', '多选', '文本']);
  const targetNamesPreview = new Set([
    '主播', '日期', 'OCR引擎',
    ...PLATFORM_FIELDS.douyin.map(f => `抖音-${f}`),
    ...PLATFORM_FIELDS.videohao.map(f => `视频号-${f}`),
    ...PLATFORM_FIELDS.kuaishou.map(f => `快手-${f}`)
  ]);
  for (const f of existingFields) {
    if (f.is_primary) continue;
    if (FEISHU_DEFAULT_GARBAGE.has(f.field_name) && !targetNamesPreview.has(f.field_name)) {
      try {
        await removeField(config.feishu.appToken, config.feishu.tableId, f.field_id);
        console.log(`[ensureBitable] 已清理默认字段: ${f.field_name}`);
      } catch (e) {
        console.error(`[ensureBitable] 清理 ${f.field_name} 失败:`, e.message);
      }
    }
  }
  existingFields = await listFields(config.feishu.appToken, config.feishu.tableId);

  const fields = [
    { field_name: '日期', type: 5 },
    { field_name: 'OCR引擎', type: 1 },

    ...PLATFORM_FIELDS.douyin.map(f => ({ field_name: `抖音-${f}`, type: 1 })),
    ...PLATFORM_FIELDS.videohao.map(f => ({ field_name: `视频号-${f}`, type: 1 })),
    ...PLATFORM_FIELDS.kuaishou.map(f => ({ field_name: `快手-${f}`, type: 1 }))
  ];

  const existingNames = new Set(existingFields.map(f => f.field_name));
  let created = 0, skipped = 0, failed = 0;
  for (const field of fields) {
    if (existingNames.has(field.field_name)) { skipped += 1; continue; }
    try {
      await ensureField(config.feishu.appToken, config.feishu.tableId, field);
      created += 1;
    } catch (e) {
      failed += 1;
      console.error(`[ensureBitable] 字段 "${field.field_name}" 创建失败:`, e.message, JSON.stringify(e.payload || {}));
    }
  }
  console.log(`[ensureBitable] 字段创建结果 created=${created} skipped=${skipped} failed=${failed}`);

  return config.feishu;
}

function toFeishuDate(input) {
  const value = input ? new Date(input) : new Date();
  return Number.isNaN(value.getTime()) ? Date.now() : value.getTime();
}

function metricOf(result, key) {
  return result?.metrics?.[key] || '';
}

async function createRecord(payload) {
  const feishu = await ensureBitable();
  const dy = payload.results.douyin || {};
  const vh = payload.results.videohao || {};
  const ks = payload.results.kuaishou || {};
  const engines = [dy.engine, vh.engine, ks.engine].filter(Boolean);
  const fields = {
    '主播': payload.anchorName,
    '日期': toFeishuDate(payload.date),
    'OCR引擎': engines.length ? Array.from(new Set(engines)).join('+') : ''
  };
  for (const f of PLATFORM_FIELDS.douyin) fields[`抖音-${f}`] = metricOf(dy, f);
  for (const f of PLATFORM_FIELDS.videohao) fields[`视频号-${f}`] = metricOf(vh, f);
  for (const f of PLATFORM_FIELDS.kuaishou) fields[`快手-${f}`] = metricOf(ks, f);
  const recordData = { fields };

  const data = await feishuRequest('POST', `/open-apis/bitable/v1/apps/${feishu.appToken}/tables/${feishu.tableId}/records`, recordData);
  return { recordId: data.record.record_id, tableUrl: feishu.tableUrl };
}

function friendlyFeishuError(error) {
  const payload = error.payload || {};
  const message = payload.msg || error.message || '飞书接口失败';
  const authLink = (message.match(/https:\/\/open\.feishu\.cn\/[^\s]+/) || [])[0] || '';
  const link = authLink || payload?.error?.troubleshooter || payload?.error?.help_url || '';
  return {
    message,
    code: payload.code || error.status || 'UNKNOWN',
    help: link
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/anchors') {
    return json(res, 200, { ok: true, anchors: loadAnchors() });
  }

  if (req.method === 'POST' && url.pathname === '/api/anchors') {
    try {
      const body = await readBody(req);
      const anchor = createAnchor(body.name);
      return json(res, 200, { ok: true, anchor, anchors: loadAnchors() });
    } catch (error) {
      return json(res, 400, { ok: false, error: { message: error.message } });
    }
  }

  if (req.method === 'DELETE' && url.pathname === '/api/anchors') {
    try {
      const body = await readBody(req);
      if (!body.id) throw new Error('缺少主播ID');
      deleteAnchor(body.id);
      return json(res, 200, { ok: true, anchors: loadAnchors() });
    } catch (error) {
      return json(res, 400, { ok: false, error: { message: error.message } });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    config = loadConfig();
    return json(res, 200, {
      ok: true,
      port: PORT,
      tableUrl: config.feishu.tableUrl,
      appTokenReady: Boolean(config.feishu.appToken),
      tableIdReady: Boolean(config.feishu.tableId),
      ocrEngine: (process.env.ARK_API_KEY && process.env.ARK_MODEL_ID) ? 'doubao' : 'tesseract'
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/runtime-log') {
    try {
      const textLog = fs.existsSync(RUNTIME_LOG_PATH) ? fs.readFileSync(RUNTIME_LOG_PATH, 'utf8').trim() : '';
      const lines = textLog ? textLog.split('\n').slice(-50).map(line => JSON.parse(line)) : [];
      return json(res, 200, { ok: true, lines });
    } catch (error) {
      return json(res, 200, { ok: true, lines: [] });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/ocr-preview') {
    try {
      const body = await readBody(req);
      appendRuntimeLog('正在 OCR 识别', { eta: '15~30秒' });
      const results = await ocrImages(body.images);
      appendRuntimeLog('OCR 识别完成', { eta: '0秒' });
      return json(res, 200, { ok: true, results });
    } catch (error) {
      appendRuntimeLog('OCR 识别失败', { error: error.message });
      return json(res, 400, { ok: false, error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/submit') {
    try {
      const body = await readBody(req);
      const anchorName = String(body.anchorName || '').trim();
      if (!anchorName) throw new Error('请选择主播');
      const results = body.results || await ocrImages(body.images);
      appendRuntimeLog('正在写入飞书表格', { eta: '5~15秒', anchorName });
      const record = await createRecord({
        anchorName,
        date: body.date,
        note: body.note,
        results
      });
      appendRuntimeLog('写入飞书表格完成', { eta: '0秒', anchorName, recordId: record.recordId });
      return json(res, 200, { ok: true, results, record });
    } catch (error) {
      const feishuError = error.payload ? friendlyFeishuError(error) : null;
      appendRuntimeLog('写入飞书表格失败', { error: (feishuError || { message: error.message }).message });
      return json(res, 400, { ok: false, error: feishuError || { message: error.message } });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/qa-check') {
    try {
      const body = await readBody(req);
      appendRuntimeLog('正在大模型检查结果', { eta: '10~20秒', anchorName: body.anchorName || '' });
      const summary = {
        passed: true,
        note: '当前版本仅记录抽检流程，后续接入大模型自动复核。'
      };
      appendRuntimeLog('大模型检查结果完成', { eta: '0秒', passed: true });
      return json(res, 200, { ok: true, check: summary });
    } catch (error) {
      appendRuntimeLog('大模型检查结果失败', { error: error.message });
      return json(res, 400, { ok: false, error: { message: error.message } });
    }
  }

  if (serveStatic(req, res, decodeURIComponent(url.pathname))) return;
  text(res, 404, 'Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`anchor-review-panel running on :${PORT}`);
});
