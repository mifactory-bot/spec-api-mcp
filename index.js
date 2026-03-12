
const express = require('express');
const { Redis } = require('@upstash/redis');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function authenticate(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing x-api-key header' });
  try {
    const keyData = await redis.hget('api_keys', apiKey);
    if (!keyData) return res.status(403).json({ error: 'Invalid API key' });
    const parsed = typeof keyData === 'string' ? JSON.parse(keyData) : keyData;
    if (parsed.credits < 5) return res.status(402).json({ error: 'Insufficient credits' });
    req.keyData = parsed;
    req.apiKey = apiKey;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Auth check failed' });
  }
}

async function deductCredits(apiKey, keyData, amount) {
  const updated = { ...keyData, credits: keyData.credits - amount };
  await redis.hset('api_keys', { [apiKey]: JSON.stringify(updated) });
  return updated.credits;
}

app.get('/', (req, res) => {
  res.json({ service: 'mifactory-spec-api', status: 'live', version: '1.0.0' });
});

app.post('/spec/convert', authenticate, async (req, res) => {
  const { documentText } = req.body;
  if (!documentText) return res.status(400).json({ error: 'Missing documentText' });
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: 'Convert this document into a structured agent-readable spec with objectives, constraints, and key information. Respond only with JSON.\n\nDocument:\n' + documentText
      }]
    });
    const spec = response.content[0].text.replace(/```json|```/g, '').trim();
    await deductCredits(req.apiKey, req.keyData, 10);
    res.json({ spec: JSON.parse(spec), credits_used: 10, credits_remaining: req.keyData.credits - 10 });
  } catch (err) {
    res.status(500).json({ error: 'Conversion failed', details: err.message });
  }
});

app.post('/spec/validate', authenticate, async (req, res) => {
  const { spec } = req.body;
  if (!spec) return res.status(400).json({ error: 'Missing spec' });
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: 'Validate this spec for completeness and consistency. Respond only with JSON: {"valid": true/false, "issues": [], "suggestions": []}.\n\nSpec:\n' + JSON.stringify(spec)
      }]
    });
    const result = response.content[0].text.replace(/```json|```/g, '').trim();
    await deductCredits(req.apiKey, req.keyData, 5);
    res.json({ validation: JSON.parse(result), credits_used: 5, credits_remaining: req.keyData.credits - 5 });
  } catch (err) {
    res.status(500).json({ error: 'Validation failed', details: err.message });
  }
});

app.get('/mcp', (req, res) => {
  res.json({ schema_version: '1.0', name: 'mifactory-spec-api', description: 'Convert documents to agent-readable specs', version: '1.0.0', tools: [{ name: 'spec_convert', description: 'Convert document to spec' }, { name: 'spec_validate', description: 'Validate a spec' }] });
});

app.post('/mcp', (req, res) => {
  const { method, id } = req.body;
  if (method === 'initialize') return res.json({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'mifactory-spec-api', version: '1.0.0' }, capabilities: { tools: {} } } });
  if (method === 'tools/list') return res.json({ jsonrpc: '2.0', id, result: { tools: [{ name: 'spec_convert', description: 'Convert document to agent-readable spec', inputSchema: { type: 'object', properties: { documentText: { type: 'string' } }, required: ['documentText'] } }, { name: 'spec_validate', description: 'Validate a spec', inputSchema: { type: 'object', properties: { spec: { type: 'object' } }, required: ['spec'] } }] } });
  res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
});

app.get('/.well-known/mcp/server-card.json', (req, res) => {
  res.json({ serverInfo: { name: 'mifactory-spec-api', version: '1.0.0' }, authentication: { required: true }, tools: [{ name: 'spec_convert', description: 'Convert document to agent-readable spec', inputSchema: { type: 'object', properties: { documentText: { type: 'string' } }, required: ['documentText'] } }, { name: 'spec_validate', description: 'Validate a spec', inputSchema: { type: 'object', properties: { spec: { type: 'object' } }, required: ['spec'] } }], resources: [], prompts: [] });
});

module.exports = app;
