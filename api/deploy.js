const https = require('https');
const crypto = require('crypto');

function call(method, host, path, token, data, xh) {
  xh = xh || {};
  return new Promise(function(resolve, reject) {
    var isGH = host.indexOf('github') > -1;
    var body = data instanceof Buffer ? data
      : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
    var h = {
      'Authorization': isGH ? 'token ' + token : 'Bearer ' + token,
      'User-Agent': 'Dan2-API/1.0',
      'Content-Length': String(body.length)
    };
    Object.assign(h, xh);
    if (!xh['Content-Type'] && !(data instanceof Buffer)) h['Content-Type'] = 'application/json';
    if (isGH) h['Accept'] = 'application/vnd.github.v3+json';
    var req = https.request({ method: method, hostname: host, path: path, headers: h }, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
    });
    req.on('error', reject);
    if (body.length) req.write(body);
    req.end();
  });
}

var sleep = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var b = req.body;
  if (!b.ghToken || !b.repoName || !b.html)
    return res.status(400).json({ error: 'Missing: ghToken, repoName, html' });

  var owner = b.owner || 'basecape';

  try {
    // 1. Create GitHub repo
    var rp = await call('POST', 'api.github.com', '/user/repos', b.ghToken, {
      name: b.repoName,
      description: (b.siteName || b.repoName) + ' — Dan2',
      private: false,
      auto_init: true
    });
    if (!rp.full_name && !(rp.message && rp.message.indexOf('already exists') > -1))
      throw new Error('Repo creation failed: ' + rp.message);
    await sleep(3000);

    // 2. Push index.html
    var enc = Buffer.from(b.html).toString('base64');
    var push = await call('PUT', 'api.github.com',
      '/repos/' + owner + '/' + b.repoName + '/contents/index.html', b.ghToken,
      { message: 'Dan2 build', content: enc });
    if (!push.content) throw new Error('Push failed: ' + push.message);

    // 3. Push vercel.json
    var vcfg = Buffer.from(JSON.stringify({ cleanUrls: true, trailingSlash: false })).toString('base64');
    await call('PUT', 'api.github.com',
      '/repos/' + owner + '/' + b.repoName + '/contents/vercel.json', b.ghToken,
      { message: 'Vercel config', content: vcfg });

    // 4. Enable GitHub Pages
    await sleep(1500);
    await call('POST', 'api.github.com',
      '/repos/' + owner + '/' + b.repoName + '/pages', b.ghToken,
      { source: { branch: 'main', path: '/' } });

    // 5. Vercel direct deploy
    var vercelUrl = null;
    if (b.vcToken) {
      var buf = Buffer.from(b.html);
      var sha = crypto.createHash('sha1').update(buf).digest('hex');
      await call('POST', 'api.vercel.com', '/v2/files', b.vcToken, buf,
        { 'Content-Type': 'application/octet-stream', 'x-vercel-digest': sha });
      var dep = await call('POST', 'api.vercel.com', '/v13/deployments', b.vcToken, {
        name: b.repoName,
        files: [{ file: 'index.html', sha: sha, size: buf.length }],
        projectSettings: { framework: null },
        target: 'production'
      });
      vercelUrl = dep.url ? 'https://' + dep.url : 'https://' + b.repoName + '.vercel.app';
    }

    return res.status(200).json({
      success: true,
      githubUrl: 'https://github.com/' + owner + '/' + b.repoName,
      pagesUrl:  'https://' + owner + '.github.io/' + b.repoName,
      vercelUrl: vercelUrl
    });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};